/**
 * App-wide visual themes.
 *
 * Design intent: a precision instrument for a DevOps engineer mid-diagnosis.
 * The palette is the GitHub-dark / modern-terminal family — cool blue-black
 * surfaces, a phosphor-green accent that IS the cursor color. Not an applied
 * SaaS theme; native to the world this user already lives in (gh CLI, modern
 * terminals). Each theme defines CSS variables consumed via var(--…); xterm
 * gets a matching theme object so the terminal stays coherent.
 */

export type ThemeId = "dark" | "light";

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface Theme {
  id: ThemeId;
  name: string;
  description: string;
  /** [canvas, panel, accent, text] — shown as a strip in the picker. */
  swatches: [string, string, string, string];
  xterm: XtermTheme;
}

export const THEMES: Record<ThemeId, Theme> = {
  dark: {
    id: "dark",
    name: "Dark",
    description: "Cool terminal black, phosphor-green accent (default)",
    swatches: ["#0a0c0f", "#0d1014", "#3ddc84", "#e6edf3"],
    xterm: {
      background: "#0a0c0f",
      foreground: "#e6edf3",
      cursor: "#3ddc84",
      cursorAccent: "#0a0c0f",
      selectionBackground: "rgba(61, 220, 132, 0.22)",
    },
  },
  light: {
    id: "light",
    name: "Light",
    description: "Cool paper UI — terminal stays dark for readability",
    swatches: ["#fbfcfd", "#f4f6f8", "#1a9c5b", "#1a1f24"],
    xterm: {
      // Terminals are dark even in light UIs — universal convention.
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#1a9c5b",
      cursorAccent: "#0d1117",
      selectionBackground: "rgba(26, 156, 91, 0.30)",
    },
  },
};

export const THEME_ORDER: ThemeId[] = ["dark", "light"];

const STORAGE_KEY = "sshade.theme.v1";

export function loadThemeId(): ThemeId {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw && raw in THEMES) {
    return raw as ThemeId;
  }
  return "dark";
}

export function saveThemeId(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

/** Set the `data-theme` attribute so the CSS overrides take effect. */
export function applyThemeAttribute(id: ThemeId): void {
  document.documentElement.setAttribute("data-theme", id);
}

export function getXtermTheme(id: ThemeId): XtermTheme {
  return THEMES[id].xterm;
}
