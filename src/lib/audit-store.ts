/**
 * Audit log of every command sshade executed on a server on the user's
 * behalf (AI Run/Paste and agent steps). Persisted in SQLite, keyed by
 * server profile id. Best-effort: logging never blocks or throws into the
 * caller.
 */

import { invoke } from "@tauri-apps/api/core";

export type AuditSource = "agent" | "run" | "paste";

export interface AuditEntry {
  id: number;
  ts: number;
  source: AuditSource;
  command: string;
  exit_code: number | null;
  output_preview: string | null;
}

const PREVIEW_MAX = 600;

/** Fire-and-forget. Swallows errors so a logging failure can't break a run. */
export function logAudit(args: {
  profileId: string;
  source: AuditSource;
  command: string;
  exitCode?: number | null;
  outputPreview?: string | null;
}): void {
  if (!args.profileId) return;
  invoke("audit_add", {
    profileId: args.profileId,
    source: args.source,
    command: args.command,
    exitCode: args.exitCode ?? null,
    outputPreview: args.outputPreview
      ? args.outputPreview.slice(0, PREVIEW_MAX)
      : null,
  }).catch((e) => console.error("[sshade] audit log failed", e));
}

export function auditList(
  profileId: string,
  limit = 200,
): Promise<AuditEntry[]> {
  return invoke<AuditEntry[]>("audit_list", { profileId, limit });
}

export function auditClear(profileId: string): Promise<void> {
  return invoke("audit_clear", { profileId });
}
