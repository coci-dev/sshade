import { type FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  type RecentServer,
  getAllGroups,
  updateRecentServer,
} from "../lib/server-profiles";

interface EditProfileModalProps {
  server: RecentServer | null;
  onClose: () => void;
  onSaved: (updated: RecentServer) => void;
}

export function EditProfileModal({
  server,
  onClose,
  onSaved,
}: EditProfileModalProps) {
  const [label, setLabel] = useState("");
  const [group, setGroup] = useState("");
  const [existingGroups, setExistingGroups] = useState<string[]>([]);

  useEffect(() => {
    if (server) {
      setLabel(server.label ?? "");
      setGroup(server.group ?? "");
      setExistingGroups(getAllGroups());
    }
  }, [server]);

  if (!server) return null;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!server) return;
    const updated = updateRecentServer(server.id, {
      label: label.trim() || undefined,
      group: group.trim() || undefined,
    });
    if (updated) onSaved(updated);
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Edit server</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} strokeWidth={1.75} />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="settings-form">
          <section>
            <p className="hint">
              {server.username}@{server.host}:{server.port}
            </p>

            <label>
              Label <span className="hint">(optional display name)</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={`${server.username}@${server.host}`}
                autoFocus
              />
            </label>

            <label>
              Group <span className="hint">(e.g. Production, Staging, Bastions)</span>
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="Ungrouped"
                list="existing-groups"
              />
              <datalist id="existing-groups">
                {existingGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </label>
          </section>

          <footer className="modal-footer">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit">Save</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
