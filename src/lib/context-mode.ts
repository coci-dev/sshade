/**
 * How much terminal context the AI panel sends with each question.
 * Persisted in localStorage so the user's preference survives restarts.
 */

const STORAGE_KEY = "sshade.context-mode.v1";

export type ContextMode =
  | "none"
  | "last-command"
  | "last-10"
  | "last-30"
  | "last-100"
  | "last-300"
  | "all";

export const CONTEXT_MODES: Array<{ id: ContextMode; label: string; shortLabel: string }> = [
  { id: "none", label: "No context", shortLabel: "No context" },
  { id: "last-command", label: "Last command output only", shortLabel: "Last command" },
  { id: "last-10", label: "Last 10 lines", shortLabel: "10 lines" },
  { id: "last-30", label: "Last 30 lines", shortLabel: "30 lines" },
  { id: "last-100", label: "Last 100 lines (default)", shortLabel: "100 lines" },
  { id: "last-300", label: "Last 300 lines", shortLabel: "300 lines" },
  { id: "all", label: "All scrollback (~1000 lines)", shortLabel: "All scrollback" },
];

const VALID_IDS = new Set(CONTEXT_MODES.map((m) => m.id));

export function loadContextMode(): ContextMode {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw && VALID_IDS.has(raw as ContextMode)) {
    return raw as ContextMode;
  }
  return "last-100";
}

export function saveContextMode(mode: ContextMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
}

export function modeShortLabel(mode: ContextMode): string {
  return CONTEXT_MODES.find((m) => m.id === mode)?.shortLabel ?? mode;
}

/** Approximate fixed-N for the "last-N" modes; -1 for special modes. */
export function modeLineLimit(mode: ContextMode): number {
  switch (mode) {
    case "none":
      return 0;
    case "last-10":
      return 10;
    case "last-30":
      return 30;
    case "last-100":
      return 100;
    case "last-300":
      return 300;
    case "all":
      return 10000;
    case "last-command":
      return -1;
  }
}
