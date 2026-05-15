import { Lock } from "lucide-react";

interface StatusBarProps {
  connected: boolean;
  host: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  readOnly: boolean;
}

export function StatusBar({
  connected,
  host,
  aiProvider,
  aiModel,
  readOnly,
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span className={connected ? "status-dot ok" : "status-dot idle"} />
      <span className="status-text">
        {connected && host ? (
          <>
            SSH · <span className="status-host">{host}</span>
          </>
        ) : (
          "Disconnected"
        )}
      </span>

      {readOnly && (
        <span className="status-readonly" title="AI cannot run commands">
          <Lock size={10} strokeWidth={2.25} />
          READ-ONLY
        </span>
      )}

      <span className="status-spacer" />

      {aiProvider && aiModel ? (
        <span className="status-ai">
          {aiProvider} · <span className="status-model">{aiModel}</span>
        </span>
      ) : (
        <span className="status-ai muted">No AI configured</span>
      )}
    </footer>
  );
}
