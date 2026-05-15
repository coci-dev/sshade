//! Persistent chat history, keyed by server profile id (`user@host:port`)
//! so a conversation survives reconnects. One SQLite file in the app data
//! dir; the whole message array is stored as a JSON blob per profile —
//! conversations are loaded/saved wholesale, never queried per-message.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

#[derive(Serialize)]
pub struct AuditEntry {
    pub id: i64,
    pub ts: i64,
    pub source: String,
    pub command: String,
    pub exit_code: Option<i64>,
    pub output_preview: Option<String>,
}

pub struct ChatStore {
    conn: Mutex<Connection>,
}

impl ChatStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS conversations (
                profile_id    TEXT PRIMARY KEY,
                messages_json TEXT NOT NULL,
                updated_at    INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS audit (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                ts             INTEGER NOT NULL,
                profile_id     TEXT NOT NULL,
                source         TEXT NOT NULL,
                command        TEXT NOT NULL,
                exit_code      INTEGER,
                output_preview TEXT
            )",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_profile
             ON audit (profile_id, id DESC)",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn audit_add(
        &self,
        profile_id: &str,
        source: &str,
        command: &str,
        exit_code: Option<i64>,
        output_preview: Option<&str>,
    ) -> Result<(), String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO audit
               (ts, profile_id, source, command, exit_code, output_preview)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                now,
                profile_id,
                source,
                command,
                exit_code,
                output_preview
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn audit_list(
        &self,
        profile_id: &str,
        limit: i64,
    ) -> Result<Vec<AuditEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, ts, source, command, exit_code, output_preview
                 FROM audit WHERE profile_id = ?1
                 ORDER BY id DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![profile_id, limit], |row| {
                Ok(AuditEntry {
                    id: row.get(0)?,
                    ts: row.get(1)?,
                    source: row.get(2)?,
                    command: row.get(3)?,
                    exit_code: row.get(4)?,
                    output_preview: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn audit_clear(&self, profile_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM audit WHERE profile_id = ?1",
            [profile_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load(&self, profile_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT messages_json FROM conversations WHERE profile_id = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([profile_id]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(row) => Ok(Some(row.get(0).map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn save(&self, profile_id: &str, json: &str) -> Result<(), String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO conversations (profile_id, messages_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(profile_id)
             DO UPDATE SET messages_json = ?2, updated_at = ?3",
            rusqlite::params![profile_id, json, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete(&self, profile_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM conversations WHERE profile_id = ?1",
            [profile_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
