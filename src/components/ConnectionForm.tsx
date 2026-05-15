import { type FormEvent, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { KeyRound, X } from "lucide-react";
import {
  type RecentServer,
  getAllGroups,
  getRecentServers,
  saveRecentServer,
} from "../lib/server-profiles";
import { type SshAuth, type SshConnectResult, sshConnect } from "../lib/ssh";

interface ConnectionFormProps {
  onConnected: (result: SshConnectResult, profile: RecentServer) => void;
  /** Save the server profile without connecting. Optional — if omitted, only Connect is shown. */
  onSaved?: (profile: RecentServer) => void;
  onCancel?: () => void;
  /** Prefill values when reconnecting to a recent server. */
  prefill?: Partial<{
    host: string;
    port: number;
    username: string;
    authMethod: "key" | "password";
    keyPath: string;
    group: string;
  }>;
}

type AuthMethod = "key" | "password";

export function ConnectionForm({
  onConnected,
  onSaved,
  onCancel,
  prefill,
}: ConnectionFormProps) {
  const [host, setHost] = useState(prefill?.host ?? "");
  const [port, setPort] = useState(prefill?.port ?? 22);
  const [username, setUsername] = useState(prefill?.username ?? "");

  const [method, setMethod] = useState<AuthMethod>(prefill?.authMethod ?? "key");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState<string | null>(prefill?.keyPath ?? null);
  const [passphrase, setPassphrase] = useState("");

  const [group, setGroup] = useState(prefill?.group ?? "");
  const [existingGroups, setExistingGroups] = useState<string[]>([]);

  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Saved servers list (only shown for NEW connections, not reconnections).
  const savedServers = useMemo(() => getRecentServers(), []);
  const showPicker = !prefill && savedServers.length > 0;

  useEffect(() => {
    setExistingGroups(getAllGroups());
  }, []);

  function loadProfile(s: RecentServer) {
    setHost(s.host);
    setPort(s.port);
    setUsername(s.username);
    setMethod(s.authMethod);
    setKeyPath(s.keyPath ?? null);
    setPassword("");
    setPassphrase("");
    setGroup(s.group ?? "");
    setError(null);
  }

  async function pickKeyFile() {
    try {
      const picked = await openDialog({
        multiple: false,
        title: "Select SSH private key",
        filters: [
          { name: "SSH keys", extensions: ["pem", "key", "rsa", "ed25519", "ecdsa"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (typeof picked === "string") setKeyPath(picked);
    } catch (err) {
      setError(`could not open file dialog: ${err}`);
    }
  }

  function validate(): SshAuth | null {
    setError(null);
    if (!host.trim()) {
      setError("Host is required.");
      return null;
    }
    if (!username.trim()) {
      setError("Username is required.");
      return null;
    }
    if (method === "key") {
      if (!keyPath) {
        setError("Please choose a private key file.");
        return null;
      }
      return { type: "key", path: keyPath, passphrase: passphrase || undefined };
    }
    return { type: "password", password };
  }

  function persist(): RecentServer {
    return saveRecentServer({
      host: host.trim(),
      port,
      username: username.trim(),
      authMethod: method,
      keyPath: method === "key" ? keyPath ?? undefined : undefined,
      group: group.trim() || undefined,
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const auth = validate();
    if (!auth) return;

    setConnecting(true);
    try {
      const result = await sshConnect({
        host: host.trim(),
        port,
        username: username.trim(),
        auth,
        cols: 80,
        rows: 24,
      });
      const profile = persist();
      onConnected(result, profile);
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleSaveOnly() {
    if (!onSaved) return;
    setError(null);
    if (!host.trim() || !username.trim()) {
      setError("Host and username are required.");
      return;
    }
    if (method === "key" && !keyPath) {
      setError("Please choose a private key file (or switch to password auth).");
      return;
    }
    setSaving(true);
    try {
      const profile = persist();
      onSaved(profile);
    } finally {
      setSaving(false);
    }
  }

  const keyBasename = keyPath ? keyPath.split(/[\\/]/).pop() ?? keyPath : null;
  const busy = connecting || saving;

  return (
    <form className="modal conn-modal" onSubmit={handleSubmit}>
      <header className="modal-header">
        <h2>{prefill ? "Reconnect" : "New connection"}</h2>
        {onCancel && (
          <button
            type="button"
            className="icon-btn"
            onClick={onCancel}
            aria-label="Close"
          >
            <X size={15} strokeWidth={1.75} />
          </button>
        )}
      </header>

      <div className="modal-body conn-body">
        {showPicker && (
          <details className="recent-pick">
            <summary>
              ↗ Load from saved
              <span className="recent-pick-count">{savedServers.length}</span>
            </summary>
            <ul className="recent-pick-list">
              {savedServers.slice(0, 12).map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="recent-pick-item"
                    onClick={() => loadProfile(s)}
                  >
                    <span className="recent-pick-label">
                      {s.label || `${s.username}@${s.host}`}
                    </span>
                    {s.group && (
                      <span className="recent-pick-group">{s.group}</span>
                    )}
                  </button>
                </li>
              ))}
              {savedServers.length > 12 && (
                <li className="recent-pick-more">
                  +{savedServers.length - 12} more in sidebar
                </li>
              )}
            </ul>
          </details>
        )}

        <label className="field">
          Host
          <input
            autoFocus
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com or 1.2.3.4"
            required
          />
        </label>

        <div className="conn-row">
          <label className="field field-port">
            Port
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              required
            />
          </label>
          <label className="field">
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ubuntu"
              required
            />
          </label>
        </div>

        <div className="conn-section">
          <div className="conn-section-head">Authentication</div>

          <div className="seg-control">
            <button
              type="button"
              className={method === "key" ? "seg active" : "seg"}
              onClick={() => setMethod("key")}
            >
              SSH Key
            </button>
            <button
              type="button"
              className={method === "password" ? "seg active" : "seg"}
              onClick={() => setMethod("password")}
            >
              Password
            </button>
          </div>

          {method === "key" ? (
            <>
              <label className="field">
                Private key
                <div className="key-picker">
                  <span className="key-display" title={keyPath ?? ""}>
                    <span className="key-icon">
                      <KeyRound size={13} strokeWidth={1.75} />
                    </span>
                    <span className="key-name">
                      {keyBasename ?? (
                        <span className="key-name-empty">No key selected</span>
                      )}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={pickKeyFile}
                    className="secondary"
                  >
                    Browse…
                  </button>
                </div>
              </label>
              <label className="field">
                Passphrase <span className="hint">(optional)</span>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="leave blank if key is not encrypted"
                />
              </label>
            </>
          ) : (
            <label className="field">
              Password <span className="hint">(not saved — re-enter each session)</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </label>
          )}
        </div>

        <div className="conn-section">
          <div className="conn-section-head">Organize</div>
          <label className="field">
            Group <span className="hint">(optional)</span>
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="e.g. Production, Staging, Bastions"
              list="conn-form-groups"
            />
            <datalist id="conn-form-groups">
              {existingGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
        </div>

        {error && <p className="error">{error}</p>}
      </div>

      <footer className="modal-footer">
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        {onSaved && (
          <button
            type="button"
            className="secondary"
            onClick={handleSaveOnly}
            disabled={busy}
            title="Save this server without connecting"
          >
            {saving ? "Saving…" : "Save only"}
          </button>
        )}
        <button type="submit" disabled={busy}>
          {connecting ? "Connecting…" : "Connect"}
        </button>
      </footer>
    </form>
  );
}
