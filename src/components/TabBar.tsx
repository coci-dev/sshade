import { Plus, Sparkles, X } from "lucide-react";

interface TabInfo {
  id: string;
  label: string;
  status: "connected" | "connecting" | "closed";
  /** True when this tab has an in-flight AI stream. */
  pending?: boolean;
}

interface TabBarProps {
  tabs: TabInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
}: TabBarProps) {
  return (
    <div className="tab-bar">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            className={active ? "tab active" : "tab"}
            onClick={() => !active && onSelect(t.id)}
            role="button"
          >
            <span
              className={
                t.status === "connected"
                  ? "tab-dot connected"
                  : t.status === "connecting"
                    ? "tab-dot connecting"
                    : "tab-dot idle"
              }
            />
            <span className="tab-label">{t.label}</span>
            {t.pending && (
              <span className="tab-pending" title="AI streaming">
                <Sparkles size={11} strokeWidth={2} />
              </span>
            )}
            <button
              type="button"
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              aria-label="Close tab"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tab-new"
        onClick={onNew}
        title="New connection"
        aria-label="New connection"
      >
        <Plus size={15} strokeWidth={1.75} />
      </button>
    </div>
  );
}
