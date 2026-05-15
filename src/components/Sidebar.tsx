import { type DragEvent, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { type RecentServer, groupServers } from "../lib/server-profiles";

interface SidebarProps {
  recents: RecentServer[];
  /** Profile IDs of servers that currently have a tab open. */
  openProfileIds: Set<string>;
  /** Profile ID of the currently focused (active) tab. */
  activeProfileId: string | null;
  onSelectRecent: (server: RecentServer) => void;
  onNewServer: () => void;
  onRemoveRecent: (id: string) => void;
  onEditProfile: (server: RecentServer) => void;
  /** Drop a server into a group ("" / null = ungrouped). */
  onMoveToGroup: (serverId: string, groupName: string | null) => void;
  /** Delete a group — its servers become ungrouped (not removed). */
  onDeleteGroup: (groupName: string) => void;
}

const UNGROUPED_KEY = "__ungrouped__";

export function Sidebar(props: SidebarProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const groups = groupServers(props.recents);

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-head">
          <span>SERVERS</span>
          <button
            type="button"
            className="icon-btn"
            onClick={props.onNewServer}
            aria-label="New server"
            title="New connection"
          >
            <Plus size={16} strokeWidth={1.75} />
          </button>
        </div>

        {props.recents.length === 0 ? (
          <p className="sidebar-empty">
            No servers yet. Click <strong>+</strong> to connect.
          </p>
        ) : (
          groups.map(({ group, servers }) => (
            <SidebarGroup
              key={group || UNGROUPED_KEY}
              groupName={group}
              servers={servers}
              draggingId={draggingId}
              setDraggingId={setDraggingId}
              dropTarget={dropTarget}
              setDropTarget={setDropTarget}
              {...props}
            />
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-action"
          onClick={props.onNewServer}
        >
          <Plus size={15} strokeWidth={1.75} />
          New server
        </button>
      </div>
    </aside>
  );
}

interface SidebarGroupProps extends SidebarProps {
  groupName: string;
  servers: RecentServer[];
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  dropTarget: string | null;
  setDropTarget: (key: string | null) => void;
}

function SidebarGroup({
  groupName,
  servers,
  draggingId,
  setDraggingId,
  dropTarget,
  setDropTarget,
  ...handlers
}: SidebarGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const isUngrouped = groupName === "";
  const displayName = groupName || "Recent";
  const groupKey = groupName || UNGROUPED_KEY;
  const isDropTarget = dropTarget === groupKey;

  // Browsers require preventDefault on BOTH dragenter AND dragover for an
  // element to be considered a valid drop target. Missing dragenter is what
  // gave the "blocked" cursor.
  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== groupKey) setDropTarget(groupKey);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function handleDragLeave(e: DragEvent) {
    // Only clear if leaving the section entirely (not just moving over children).
    const related = e.relatedTarget as Node | null;
    if (
      related &&
      e.currentTarget instanceof Node &&
      e.currentTarget.contains(related)
    ) {
      return;
    }
    if (dropTarget === groupKey) setDropTarget(null);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const serverId = e.dataTransfer.getData("text/plain");
    setDropTarget(null);
    setDraggingId(null);
    if (!serverId) return;
    handlers.onMoveToGroup(serverId, isUngrouped ? null : groupName);
  }

  return (
    <div
      className={`sidebar-group${isDropTarget ? " drop-target" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="sidebar-group-head">
        <button
          type="button"
          className="sidebar-group-toggle"
          onClick={() => setCollapsed((v) => !v)}
        >
          <span className="sidebar-group-caret">
            {collapsed ? (
              <ChevronRight size={13} strokeWidth={2} />
            ) : (
              <ChevronDown size={13} strokeWidth={2} />
            )}
          </span>
          <span className="sidebar-group-name">{displayName}</span>
          <span className="sidebar-group-count">{servers.length}</span>
        </button>
        {!isUngrouped && (
          <button
            type="button"
            className="group-delete"
            onClick={() => handlers.onDeleteGroup(groupName)}
            title={`Delete group "${groupName}" — servers stay`}
            aria-label="Delete group"
          >
            ✕
          </button>
        )}
      </div>

      {!collapsed && (
        <ul className="server-list">
          {servers.map((s) => {
            const active = s.id === handlers.activeProfileId;
            const open = handlers.openProfileIds.has(s.id);
            const isDragging = s.id === draggingId;
            return (
              <li
                key={s.id}
                className={`server-item${active ? " active" : ""}${isDragging ? " dragging" : ""}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", s.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDraggingId(s.id);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDropTarget(null);
                }}
              >
                <button
                  type="button"
                  className="server-row"
                  onClick={() => !active && handlers.onSelectRecent(s)}
                  title={`${s.username}@${s.host}:${s.port}`}
                >
                  <span
                    className={
                      active
                        ? "server-dot connected"
                        : open
                          ? "server-dot open"
                          : "server-dot idle"
                    }
                  />
                  <span className="server-label">
                    {s.label || `${s.username}@${s.host}`}
                  </span>
                </button>
                <div className="server-actions">
                  <button
                    type="button"
                    className="server-icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlers.onEditProfile(s);
                    }}
                    title="Edit server"
                    aria-label="Edit"
                  >
                    <Pencil size={13} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    className="server-icon-btn danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlers.onRemoveRecent(s.id);
                    }}
                    title="Delete saved server (also closes any open session)"
                    aria-label="Delete saved server"
                  >
                    <Trash2 size={13} strokeWidth={1.75} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
