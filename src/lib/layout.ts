/**
 * UI layout preferences (panel positions, sizes, open states).
 * Persisted in localStorage with debouncing on the call-site side so drag
 * operations don't spam writes.
 */

export type AiPosition = "right" | "bottom";

export interface LayoutPrefs {
  aiPosition: AiPosition;
  aiOpen: boolean;
  sidebarOpen: boolean;
  /** Width of the AI panel when docked right. */
  aiWidth: number;
  /** Height of the AI panel when docked bottom. */
  aiHeight: number;
  /** Width of the left sidebar. */
  sidebarWidth: number;
  /** Safety: when true, AI-suggested commands cannot be Run/Pasted. */
  readOnly: boolean;
}

const STORAGE_KEY = "sshade.layout.v1";

export const LAYOUT_BOUNDS = {
  sidebar: { min: 180, max: 420, default: 240 },
  aiWidth: { min: 280, max: 800, default: 380 },
  aiHeight: { min: 140, max: 700, default: 320 },
};

const DEFAULT: LayoutPrefs = {
  aiPosition: "right",
  aiOpen: true,
  sidebarOpen: true,
  aiWidth: LAYOUT_BOUNDS.aiWidth.default,
  aiHeight: LAYOUT_BOUNDS.aiHeight.default,
  sidebarWidth: LAYOUT_BOUNDS.sidebar.default,
  readOnly: false,
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sanitize(prefs: Partial<LayoutPrefs>): LayoutPrefs {
  return {
    aiPosition: prefs.aiPosition === "bottom" ? "bottom" : "right",
    aiOpen: prefs.aiOpen ?? DEFAULT.aiOpen,
    sidebarOpen: prefs.sidebarOpen ?? DEFAULT.sidebarOpen,
    aiWidth: clamp(
      prefs.aiWidth ?? DEFAULT.aiWidth,
      LAYOUT_BOUNDS.aiWidth.min,
      LAYOUT_BOUNDS.aiWidth.max,
    ),
    aiHeight: clamp(
      prefs.aiHeight ?? DEFAULT.aiHeight,
      LAYOUT_BOUNDS.aiHeight.min,
      LAYOUT_BOUNDS.aiHeight.max,
    ),
    sidebarWidth: clamp(
      prefs.sidebarWidth ?? DEFAULT.sidebarWidth,
      LAYOUT_BOUNDS.sidebar.min,
      LAYOUT_BOUNDS.sidebar.max,
    ),
    readOnly: prefs.readOnly ?? DEFAULT.readOnly,
  };
}

export function loadLayout(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    return sanitize(JSON.parse(raw) as Partial<LayoutPrefs>);
  } catch {
    return DEFAULT;
  }
}

export function saveLayout(prefs: LayoutPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* full localStorage — ignore */
  }
}
