/**
 * Typed bindings for the Rust SSH commands and events.
 *
 * Tauri converts `snake_case` Rust arg names into `camelCase` on the JS
 * side automatically — we keep the call sites readable.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SshAuth =
  | { type: "password"; password: string }
  | { type: "key"; path: string; passphrase?: string };

export interface SshConnectConfig {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  cols: number;
  rows: number;
}

export interface SshConnectResult {
  session_id: string;
  /** Login banner + initial prompt bytes captured before the listener was attached. */
  initial: number[];
}

export interface SshDataEvent {
  session_id: string;
  /** base64 (see SshDataEvent in ssh.rs) — decode with `b64ToBytes`. */
  data: string;
}

/** Decode a base64 `ssh:data` payload to raw bytes. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SshClosedEvent {
  session_id: string;
  reason: string;
}

export function sshConnect(config: SshConnectConfig): Promise<SshConnectResult> {
  return invoke<SshConnectResult>("ssh_connect", { config });
}

export function sshSendInput(sessionId: string, data: number[]): Promise<void> {
  return invoke("ssh_send_input", { sessionId, data });
}

export function sshResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("ssh_resize", { sessionId, cols, rows });
}

export function sshDisconnect(sessionId: string): Promise<void> {
  return invoke("ssh_disconnect", { sessionId });
}

export function onSshData(handler: (e: SshDataEvent) => void): Promise<UnlistenFn> {
  return listen<SshDataEvent>("ssh:data", (evt) => handler(evt.payload));
}

export function onSshClosed(handler: (e: SshClosedEvent) => void): Promise<UnlistenFn> {
  return listen<SshClosedEvent>("ssh:closed", (evt) => handler(evt.payload));
}
