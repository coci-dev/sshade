# sshade — Interface Design System

> SSH terminal client with embedded AI assistant. IDE-style three-panel
> layout (servers sidebar · terminal · AI panel). This file is the source
> of truth for visual decisions — read it before touching UI.

## Intent

- **Who:** a DevOps/sysadmin mid-diagnosis. A server is misbehaving, logs
  scroll, they need answers fast. Lives in terminals all day. Impatient
  with chrome; values density and speed.
- **What they do:** _diagnose_. The terminal is the hero — everything else
  serves it.
- **Feel:** a precision instrument. Cold, focused, terminal-native. Not
  warm, not playful, zero decoration.

## Direction

**"One terminal, paned."** A single coherent dark surface divided by
hairline borders into panes (tmux/tiling-WM aesthetic), not separate
"sidebar world / content world" zones.

## Signature — the cursor-block

Active/identity states are **solid rectangular blocks** (the terminal
cursor `▌`), never rounded pills or spinners. The accent color **is** the
cursor color. Appears in (keep it locatable in ≥5 places):

1. Server status dots — squares (`border-radius: 1px`), not circles
2. Tab dots — squares
3. Status-bar dot — square
4. AI identity dot — square
5. Active tab — 2px solid accent block on the leading edge (`::before`)
6. AI "thinking" — a blinking cursor block (`.cursor-blink`), not `…`/spinner

If you add a new active/identity indicator, it must be a cursor-block.

## Iconography

`lucide-react` only — **no emojis in chrome** (emojis render
inconsistently per-OS, are colorful/playful against the precision-tool
intent, and can't be tinted by the theme). Lucide SVGs inherit
`currentColor` so they theme automatically. Convention: `size={14-16}`,
`strokeWidth={1.75}` (2 for tiny 11-13px glyphs). Wrap icon-only buttons
in `display:inline-flex` centering; icon+text uses `gap`. Plain text
symbols in status flow (✓ ⚠) and keyboard hints (⌘K, Alt+1) stay as text
— they're content, not chrome, and render fine.

## Palette

Family: **GitHub-dark / modern-terminal**. Chosen because this user already
lives in `gh` CLI and modern terminals — the palette is native to their
world, not an applied SaaS theme. **Never** use a purple/violet accent
(that's the generic-AI-startup default we explicitly rejected).

- **Accent = cursor color**, phosphor-green family.
  - dark `#3ddc84` · light `#1a9c5b` · matrix `#00ff66`
- **Semantics are ANSI-coded** (terminal users read meaning in them):
  success = green (same as accent), warning = amber `#e3b341`,
  danger = terminal-red `#f85149`.
- Surfaces: cool blue-black, single hue, lightness-only shifts.

## Surfaces — elevation ramp

Same cool hue, whisper-quiet 2–4% lightness steps. Sidebar shares the
panel surface and is separated by a border only (no different hue).

| Token | Dark | Role |
|-------|------|------|
| `--bg-app` | `#0a0c0f` | canvas / terminal |
| `--bg-panel` | `#0d1014` | sidebar + AI panel |
| `--bg-elevated` | `#12161c` | modals, dropdowns (one level up) |
| `--bg-hover` | `#161b22` | interactive hover |
| `--bg-input` | `#07090b` | inputs are **inset** — darker, not lighter |

Active tab uses `--bg-app` so it visually "connects" to the terminal below.
Selected items use an accent **tint** (`--bg-active`), never a separate gray.

## Text hierarchy

Four deliberate levels, cool grays (never muddy warm-gray):
`--text-primary #e6edf3` · `--text-secondary #9198a1` ·
`--text-muted #636c76` · `--text-dim #424a54` · `--text-strong #f0f6fc`.
Code/inline reads accent-tinted (`--text-code-inline`).

## Depth strategy

**Borders + surface-shift only.** No drama shadows (terminals are flat
grids). Exception: modals get one strong shadow to lift off the plane.
Borders are **hairline rgba** (`rgba(240,246,252,0.10)` default,
`0.20` strong) so structure whispers — never solid hex borders.

## Typography

- **JetBrains Mono** — terminal, data, technical labels, code, paths,
  hostnames, the status bar host. Tabular numbers.
- **Inter** — prose chrome (headings, buttons, descriptions).
- Monospace is the terminal's native voice; data must align.

## Spacing & radius

- Base unit: **4px**. Stick to multiples.
- Radius: small (inputs/buttons) 4px · cards 6px · modals 8px. Status
  blocks/cursor-blocks 1px (sharp = technical). Don't mix sharp & soft
  randomly.

## Themes (exactly 2)

`dark` (default) · `light` (UI is light **but terminal stays dark** —
universal convention).
Defined as `:root[data-theme="…"]` token blocks in `src/App.css`.
Themes registered in `src/lib/themes.ts` (also carries the per-theme
xterm.js color object). Backdrop opacity is per-theme (`--backdrop-bg`)
so light themes don't get drowned.

## Hard rules / gotchas

- **Never `replace_all` hex codes globally in App.css.** It mangled the
  token *definitions* into circular `--x: var(--x)` refs and silently
  broke every theme. Edit definition blocks by hand.
- Token definitions live only in the `:root` blocks at the top of
  `src/App.css`. Everything else consumes `var(--…)`.
- One accent only. Color must mean something — no decorative gradients.
- Run the squint test: blur the UI; hierarchy should survive, nothing
  should jump.

## Token reference

Canonical names (defined per theme, consumed everywhere):
`--bg-app|panel|elevated|hover|tabs|tab-active|active|input|code|code-header`
· `--text-primary|secondary|muted|dim|strong|code-inline`
· `--border-default|strong`
· `--accent|accent-hover|accent-soft|accent-fg|accent-bg-tint|accent-bg-tint-strong|accent-glow`
· `--success|success-soft|success-bright|warning|danger|danger-soft`
· `--user-msg-bg|user-msg-fg` · `--scrollbar-thumb` · `--backdrop-bg`
· layout (set inline from React): `--sidebar-w|aipanel-w|aipanel-h`
