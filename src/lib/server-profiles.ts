/**
 * Lightweight "recently connected" server list, stored in localStorage.
 *
 * SECURITY: only non-secret data is persisted (host, port, username, key file
 * PATH, auth method, label, group). Passwords and passphrases are NEVER saved
 * — those must be re-entered each session. When we add full profile
 * persistence backed by rusqlite + keyring-rs this module gets replaced.
 */

const STORAGE_KEY = "sshade.recent-servers.v1";
const MAX_RECENT = 30;

export type AuthMethod = "key" | "password";

export interface RecentServer {
  /** Stable id derived from host+port+username, used as React key. */
  id: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** File path to the private key, when authMethod is "key". */
  keyPath?: string;
  /** Display label — defaults to `username@host`. */
  label?: string;
  /** Folder/group name shown in the sidebar (Production, Staging, etc.). */
  group?: string;
  /** Epoch ms of last successful connection. */
  lastUsed: number;
}

function idFor(s: { host: string; port: number; username: string }): string {
  return `${s.username}@${s.host}:${s.port}`;
}

export function getRecentServers(): RecentServer[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as RecentServer[];
    if (!Array.isArray(list)) return [];
    return list.sort((a, b) => b.lastUsed - a.lastUsed);
  } catch {
    return [];
  }
}

export function saveRecentServer(
  s: Omit<RecentServer, "id" | "lastUsed"> & { lastUsed?: number },
): RecentServer {
  const id = idFor(s);
  // Preserve existing label/group if not provided.
  const existing = getRecentServers().find((r) => r.id === id);
  const merged: RecentServer = {
    id,
    host: s.host,
    port: s.port,
    username: s.username,
    authMethod: s.authMethod,
    keyPath: s.keyPath ?? existing?.keyPath,
    label: s.label ?? existing?.label,
    group: s.group ?? existing?.group,
    lastUsed: s.lastUsed ?? Date.now(),
  };

  const current = getRecentServers();
  const filtered = current.filter((r) => r.id !== id);
  filtered.unshift(merged);
  const trimmed = filtered.slice(0, MAX_RECENT);

  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  return merged;
}

export function updateRecentServer(
  id: string,
  patch: Partial<Pick<RecentServer, "label" | "group">>,
): RecentServer | null {
  const current = getRecentServers();
  const idx = current.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const updated: RecentServer = { ...current[idx], ...patch };
  current[idx] = updated;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  return updated;
}

/**
 * Move a server to a group. Pass `null` or empty string to ungroup.
 * Returns the updated server or null if id not found.
 */
export function moveServerToGroup(
  id: string,
  group: string | null,
): RecentServer | null {
  const current = getRecentServers();
  const idx = current.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const updated: RecentServer = { ...current[idx] };
  const trimmed = group?.trim();
  if (trimmed) {
    updated.group = trimmed;
  } else {
    delete updated.group;
  }
  current[idx] = updated;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  return updated;
}

/**
 * "Delete a group": every server currently in `groupName` becomes ungrouped.
 * The servers themselves are NOT removed.
 */
export function ungroupAllInGroup(groupName: string): void {
  const current = getRecentServers();
  let changed = false;
  for (const s of current) {
    if (s.group === groupName) {
      delete s.group;
      changed = true;
    }
  }
  if (changed) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  }
}

export function removeRecentServer(id: string): void {
  const current = getRecentServers().filter((r) => r.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
}

/**
 * Group servers by their `group` field. Ungrouped go under "" (rendered as
 * "Recent" in the UI). Returns entries sorted: groups alphabetically, ungrouped last.
 */
export function groupServers(servers: RecentServer[]): Array<{
  group: string;
  servers: RecentServer[];
}> {
  const map = new Map<string, RecentServer[]>();
  for (const s of servers) {
    const key = s.group?.trim() || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  const groupNames = Array.from(map.keys())
    .filter((g) => g !== "")
    .sort((a, b) => a.localeCompare(b));
  const result = groupNames.map((g) => ({ group: g, servers: map.get(g)! }));
  if (map.has("")) {
    result.push({ group: "", servers: map.get("")! });
  }
  return result;
}

/** Distinct group names already in use, for autocomplete. */
export function getAllGroups(): string[] {
  const set = new Set<string>();
  for (const s of getRecentServers()) {
    if (s.group?.trim()) set.add(s.group.trim());
  }
  return Array.from(set).sort();
}
