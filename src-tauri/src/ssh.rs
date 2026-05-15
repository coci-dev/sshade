//! SSH client backend for sshade.
//!
//! Owns an `SshState` (shared via `tauri::State`) keyed by session id. Each
//! session spawns a tokio task that pipes bytes between the russh channel and
//! the frontend (via Tauri events for output, an mpsc channel for input).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle, Handler, Msg};
use russh::keys::{ssh_key::PublicKey, PrivateKeyWithHashAlg};
use russh::{Channel, ChannelMsg};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

/// How the frontend wants to authenticate. Tagged enum: `{ "type": "password", "password": "…" }`
/// or `{ "type": "key", "path": "…", "passphrase": "…" }`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SshAuth {
    Password {
        password: String,
    },
    Key {
        path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
}

/// Config the frontend sends to open a new session.
#[derive(Debug, Deserialize)]
pub struct SshConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub cols: u32,
    pub rows: u32,
}

/// Returned by `ssh_connect`. Includes any bytes the server flushed before
/// the frontend had a chance to subscribe to `ssh:data` (login banner + first
/// prompt). The frontend writes these to xterm BEFORE attaching the listener
/// so nothing is lost.
#[derive(Debug, Serialize)]
pub struct SshConnectResult {
    pub session_id: String,
    pub initial: Vec<u8>,
}

/// Payload emitted to the frontend for every chunk of SSH output.
///
/// `data` is **base64** — Tauri serializes event payloads as JSON, so a
/// raw `Vec<u8>` would go as `[27,91,...]` (~4-5 bytes/byte + serde cost).
/// base64 is ~1.33x and parses trivially. This is the terminal's hot path.
#[derive(Debug, Serialize, Clone)]
pub struct SshDataEvent {
    pub session_id: String,
    pub data: String,
}

/// Payload emitted when a session ends (graceful close or error).
#[derive(Debug, Serialize, Clone)]
pub struct SshClosedEvent {
    pub session_id: String,
    pub reason: String,
}

/// Commands the per-session task accepts.
enum SessionCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// Shared state held by Tauri. Maps `session_id` -> sender that drives the
/// session task.
#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<String, mpsc::Sender<SessionCommand>>>,
}

impl SshState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// SSH client handler. Verifies the server key against `~/.ssh/known_hosts`
/// using a Trust-On-First-Use model (same as OpenSSH `accept-new`):
/// - host known + key matches  → trust
/// - host unseen               → record it, then trust
/// - host known + key CHANGED  → reject (possible MITM)
struct ClientHandler {
    host: String,
    port: u16,
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

/// Append a `host keytype keydata` line to `~/.ssh/known_hosts` (TOFU).
fn learn_host(host: &str, port: u16, key: &PublicKey) -> std::io::Result<()> {
    use std::io::Write;
    let home = home_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no home directory")
    })?;
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&ssh_dir)?;
    let path = ssh_dir.join("known_hosts");

    let entry_host = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    // `to_openssh()` => "ssh-ed25519 AAAA... [comment]" — keep first two fields.
    let openssh = key
        .to_openssh()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    let mut parts = openssh.split_whitespace();
    let ktype = parts.next().unwrap_or_default();
    let kdata = parts.next().unwrap_or_default();
    let line = format!("{entry_host} {ktype} {kdata}\n");

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    f.write_all(line.as_bytes())
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        match russh::keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                if let Err(e) = learn_host(&self.host, self.port, server_public_key) {
                    eprintln!("[sshade] could not persist known_hosts entry: {e}");
                }
                Ok(true)
            }
            Err(e) => {
                eprintln!(
                    "[sshade] SECURITY: host key MISMATCH for {}:{} — refusing to connect ({e}). \
                     If you intentionally changed the server, remove its line from ~/.ssh/known_hosts.",
                    self.host, self.port
                );
                Ok(false)
            }
        }
    }
}

/// Open a new SSH session. Returns the generated `session_id` plus any bytes
/// captured before the streaming task is spawned (the login banner + initial
/// prompt).
pub async fn connect(
    state: &SshState,
    app: AppHandle,
    config: SshConnectConfig,
) -> Result<SshConnectResult, String> {
    let russh_config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });

    let addr = (config.host.as_str(), config.port);
    let handler = ClientHandler {
        host: config.host.clone(),
        port: config.port,
    };
    let mut handle: Handle<ClientHandler> = client::connect(russh_config, addr, handler)
        .await
        .map_err(|e| {
            // A key mismatch surfaces here as a handshake failure.
            format!(
                "connect failed: {e} (if this says key/signature mismatch, the \
                 server's host key changed — possible MITM, or the server was \
                 rebuilt; remove its line from ~/.ssh/known_hosts to re-trust)"
            )
        })?;

    let auth = match config.auth {
        SshAuth::Password { password } => handle
            .authenticate_password(&config.username, &password)
            .await
            .map_err(|e| format!("auth error: {e}"))?,
        SshAuth::Key { path, passphrase } => {
            let key = russh::keys::load_secret_key(&path, passphrase.as_deref())
                .map_err(|e| format!("failed to load key '{path}': {e}"))?;

            // Negotiate the best RSA hash the server supports (some servers
            // reject SHA-1; SHA-256/512 are the modern choices). For non-RSA
            // keys this returns None which is fine.
            // russh returns Result<Option<Option<HashAlg>>>: outer Option =
            // whether the server advertised RSA support, inner = which hash.
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            let pk = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);

            handle
                .authenticate_publickey(&config.username, pk)
                .await
                .map_err(|e| format!("auth error: {e}"))?
        }
    };

    if !auth.success() {
        return Err("authentication rejected by server".into());
    }

    let mut channel: Channel<Msg> = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("channel open: {e}"))?;

    channel
        .request_pty(false, "xterm-256color", config.cols, config.rows, 0, 0, &[])
        .await
        .map_err(|e| format!("pty request: {e}"))?;

    channel
        .request_shell(false)
        .await
        .map_err(|e| format!("shell request: {e}"))?;

    // Drain the channel for a short moment to grab the login banner + initial
    // prompt BEFORE handing off to the streaming task. Otherwise the frontend
    // misses them due to the listener-attachment race.
    let mut initial: Vec<u8> = Vec::new();
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(400);
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        let remaining = deadline - now;
        tokio::select! {
            _ = tokio::time::sleep(remaining) => break,
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => initial.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => initial.extend_from_slice(&data),
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<SessionCommand>(64);

    state.sessions.lock().await.insert(session_id.clone(), tx);

    spawn_session_task(app, session_id.clone(), handle, channel, rx);

    Ok(SshConnectResult {
        session_id,
        initial,
    })
}

fn spawn_session_task(
    app: AppHandle,
    session_id: String,
    handle: Handle<ClientHandler>,
    mut channel: Channel<Msg>,
    mut rx: mpsc::Receiver<SessionCommand>,
) {
    tokio::spawn(async move {
        let reason = loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        emit_data(&app, &session_id, data.to_vec());
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        emit_data(&app, &session_id, data.to_vec());
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        break format!("remote exited with status {exit_status}");
                    }
                    Some(ChannelMsg::Close) | None => {
                        break "channel closed".to_string();
                    }
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(SessionCommand::Data(bytes)) => {
                        if let Err(e) = channel.data(&bytes[..]).await {
                            break format!("write error: {e}");
                        }
                    }
                    Some(SessionCommand::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(SessionCommand::Close) | None => {
                        let _ = channel.close().await;
                        break "disconnected by client".to_string();
                    }
                }
            }
        };

        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        let _ = app.emit(
            "ssh:closed",
            SshClosedEvent {
                session_id: session_id.clone(),
                reason,
            },
        );
    });
}

fn emit_data(app: &AppHandle, session_id: &str, data: Vec<u8>) {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let _ = app.emit(
        "ssh:data",
        SshDataEvent {
            session_id: session_id.to_string(),
            data: STANDARD.encode(&data),
        },
    );
}

pub async fn send_input(
    state: &SshState,
    session_id: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let tx = sessions
        .get(session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;
    tx.send(SessionCommand::Data(bytes))
        .await
        .map_err(|e| format!("send error: {e}"))
}

pub async fn resize(
    state: &SshState,
    session_id: &str,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let tx = sessions
        .get(session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;
    tx.send(SessionCommand::Resize { cols, rows })
        .await
        .map_err(|e| format!("send error: {e}"))
}

pub async fn disconnect(state: &SshState, session_id: &str) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(tx) = sessions.remove(session_id) {
        let _ = tx.send(SessionCommand::Close).await;
    }
    Ok(())
}
