//! sshade Tauri backend entry point.

mod chats;
mod secrets;
mod ssh;

use chats::{AuditEntry, ChatStore};
use ssh::{SshConnectConfig, SshConnectResult, SshState};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
async fn audit_add(
    store: State<'_, ChatStore>,
    profile_id: String,
    source: String,
    command: String,
    exit_code: Option<i64>,
    output_preview: Option<String>,
) -> Result<(), String> {
    store.audit_add(
        &profile_id,
        &source,
        &command,
        exit_code,
        output_preview.as_deref(),
    )
}

#[tauri::command]
async fn audit_list(
    store: State<'_, ChatStore>,
    profile_id: String,
    limit: i64,
) -> Result<Vec<AuditEntry>, String> {
    store.audit_list(&profile_id, limit)
}

#[tauri::command]
async fn audit_clear(
    store: State<'_, ChatStore>,
    profile_id: String,
) -> Result<(), String> {
    store.audit_clear(&profile_id)
}

#[tauri::command]
async fn chat_load(
    store: State<'_, ChatStore>,
    profile_id: String,
) -> Result<Option<String>, String> {
    store.load(&profile_id)
}

#[tauri::command]
async fn chat_save(
    store: State<'_, ChatStore>,
    profile_id: String,
    messages_json: String,
) -> Result<(), String> {
    store.save(&profile_id, &messages_json)
}

#[tauri::command]
async fn chat_delete(
    store: State<'_, ChatStore>,
    profile_id: String,
) -> Result<(), String> {
    store.delete(&profile_id)
}

#[tauri::command]
async fn secret_set(account: String, value: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || secrets::set(&account, &value))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn secret_get(account: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || secrets::get(&account))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn secret_delete(account: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || secrets::delete(&account))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn ssh_connect(
    state: State<'_, SshState>,
    app: AppHandle,
    config: SshConnectConfig,
) -> Result<SshConnectResult, String> {
    ssh::connect(state.inner(), app, config).await
}

#[tauri::command]
async fn ssh_send_input(
    state: State<'_, SshState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    ssh::send_input(state.inner(), &session_id, data).await
}

#[tauri::command]
async fn ssh_resize(
    state: State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    ssh::resize(state.inner(), &session_id, cols, rows).await
}

#[tauri::command]
async fn ssh_disconnect(
    state: State<'_, SshState>,
    session_id: String,
) -> Result<(), String> {
    ssh::disconnect(state.inner(), &session_id).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            app.manage(SshState::new());
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app data dir: {e}"))?;
            std::fs::create_dir_all(&dir).ok();
            let store = ChatStore::open(&dir.join("chats.db"))
                .map_err(|e| format!("chat db: {e}"))?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_send_input,
            ssh_resize,
            ssh_disconnect,
            secret_set,
            secret_get,
            secret_delete,
            chat_load,
            chat_save,
            chat_delete,
            audit_add,
            audit_list,
            audit_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
