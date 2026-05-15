/**
 * Frontend bindings to the OS credential manager (via Rust keyring).
 * `account` namespaces secrets, e.g. "ai.anthropic".
 */

import { invoke } from "@tauri-apps/api/core";

export function secretSet(account: string, value: string): Promise<void> {
  return invoke("secret_set", { account, value });
}

export function secretGet(account: string): Promise<string | null> {
  return invoke<string | null>("secret_get", { account });
}

export function secretDelete(account: string): Promise<void> {
  return invoke("secret_delete", { account });
}
