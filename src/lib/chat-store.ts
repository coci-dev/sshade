/**
 * Persistent chat history bridge. Conversations are keyed by server
 * profile id (`user@host:port`) so they survive reconnects, plus a
 * special key for the no-session general chat.
 */

import { invoke } from "@tauri-apps/api/core";

export const GENERAL_CHAT_KEY = "__general__";

/** Returns the stored messages JSON, or null if none. */
export function chatLoad(profileId: string): Promise<string | null> {
  return invoke<string | null>("chat_load", { profileId });
}

export function chatSave(profileId: string, messagesJson: string): Promise<void> {
  return invoke("chat_save", { profileId, messagesJson });
}

export function chatDelete(profileId: string): Promise<void> {
  return invoke("chat_delete", { profileId });
}
