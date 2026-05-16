import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  ClipboardPaste,
  RefreshCw,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  type AuditEntry,
  type AuditSource,
  auditClear,
  auditList,
} from "../lib/audit-store";

interface AuditModalProps {
  profileId: string;
  onClose: () => void;
}

const SOURCE_META: Record<
  AuditSource,
  { label: string; Icon: typeof Bot }
> = {
  agent: { label: "Agent", Icon: Bot },
  run: { label: "Run", Icon: Terminal },
  paste: { label: "Paste", Icon: ClipboardPaste },
};

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })} ${time}`;
}

export function AuditModal({ profileId, onClose }: AuditModalProps) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  const refresh = useCallback(() => {
    auditList(profileId)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [profileId]);

  // Fetch on open AND keep polling: audit writes are fire-and-forget, so
  // a one-shot fetch goes stale the moment the agent / Run / Paste logs
  // another command. Poll while the modal is open so it stays live.
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [refresh]);

  function handleClear() {
    auditClear(profileId)
      .then(() => setEntries([]))
      .catch(() => {});
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal audit-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>
            AI activity log
            {entries && entries.length > 0 && (
              <span className="audit-count">{entries.length}</span>
            )}
          </h2>
          <div className="audit-header-actions">
            <button
              className="icon-btn"
              onClick={refresh}
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw size={14} strokeWidth={1.75} />
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={15} strokeWidth={1.75} />
            </button>
          </div>
        </header>

        <p className="hint audit-sub">
          Commands the assistant executed on this server — agent steps and
          Run / Paste from the chat. Commands you typed in the terminal
          yourself are <strong>not</strong> recorded here. Stored locally on
          this machine; output is redacted best-effort but may still contain
          sensitive data (e.g. credentials a command prints). Use{" "}
          <strong>Clear log</strong> to wipe it.
        </p>

        <div className="audit-list">
          {entries === null ? (
            <p className="audit-empty">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="audit-empty">
              Nothing yet — the assistant hasn't run any commands on this
              server (agent / Run / Paste).
            </p>
          ) : (
            entries.map((e) => {
              const meta = SOURCE_META[e.source];
              const Icon = meta.Icon;
              const failed =
                e.exit_code !== null && e.exit_code !== 0;
              return (
                <div key={e.id} className="audit-row">
                  <div className="audit-row-top">
                    <span className={`audit-tag audit-tag-${e.source}`}>
                      <Icon size={11} strokeWidth={2} />
                      {meta.label}
                    </span>
                    <code className="audit-cmd">{e.command}</code>
                    {e.exit_code !== null && (
                      <span
                        className={
                          failed
                            ? "audit-exit audit-exit-fail"
                            : "audit-exit audit-exit-ok"
                        }
                        title="Exit code"
                      >
                        {e.exit_code}
                      </span>
                    )}
                    <span className="audit-ts">{fmtTime(e.ts)}</span>
                  </div>
                  {e.output_preview && (
                    <pre className="audit-output">{e.output_preview}</pre>
                  )}
                </div>
              );
            })
          )}
        </div>

        <footer className="modal-footer">
          <button
            type="button"
            className="secondary danger"
            onClick={handleClear}
            disabled={!entries || entries.length === 0}
          >
            <Trash2 size={14} strokeWidth={1.75} />
            Clear log
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
