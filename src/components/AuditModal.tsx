import { useCallback, useEffect, useState } from "react";
import { Bot, ClipboardPaste, Terminal, Trash2, X } from "lucide-react";
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

  useEffect(() => {
    refresh();
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
          <h2>Activity log</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} strokeWidth={1.75} />
          </button>
        </header>

        <p className="hint audit-sub">
          Every command sshade ran on this server on your behalf.
        </p>

        <div className="audit-list">
          {entries === null ? (
            <p className="audit-empty">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="audit-empty">
              Nothing yet — no commands have been run here.
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
