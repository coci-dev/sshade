//! Thin wrapper over the OS credential manager (Windows Credential Manager,
//! macOS Keychain, Linux Secret Service) via the `keyring` crate.
//!
//! Everything is stored under one service name; the `account` string
//! namespaces individual secrets (e.g. "ai.anthropic").

use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "sshade";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("keyring entry: {e}"))
}

pub fn set(account: &str, value: &str) -> Result<(), String> {
    entry(account)?
        .set_password(value)
        .map_err(|e| format!("keyring set: {e}"))
}

/// Returns `None` when there is no stored secret for `account`.
pub fn get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get: {e}")),
    }
}

pub fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}
