import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Sparkles } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";

import {
  b64ToBytes,
  onSshClosed,
  onSshData,
  sshResize,
  sshSendInput,
} from "../lib/ssh";
import type { XtermTheme } from "../lib/themes";

interface TerminalProps {
  sessionId: string;
  /** Bytes captured by the backend before the listener attached (banner + prompt). */
  initialBytes?: number[] | null;
  /** Theme to apply to xterm. Updates dynamically without recreating xterm. */
  xtermTheme: XtermTheme;
  onClosed: (reason: string) => void;
  /** Called with the selected lines when the user clicks "Ask AI about selection". */
  onAskSelection?: (lines: string[]) => void;
}

export interface TerminalHandle {
  /** Read the last `n` lines of the visible buffer (excluding trailing empty). */
  getLastLines(n: number): string[];
  /**
   * Heuristic: find the last shell-prompt line that had a command typed
   * after it, and return that line + everything below it (the output of
   * the most recently executed command, up to and including the new prompt).
   */
  getLastCommandOutput(): string[];
  focus(): void;
  /** Type a command into the remote shell WITHOUT pressing Enter — user can edit. */
  pasteCommand(cmd: string): void;
  /** Type a command into the remote shell and press Enter. */
  runCommand(cmd: string): void;
}

/**
 * After a shell exits (`exit`, server-side kill) the SSH channel closes;
 * an in-flight resize/input then rejects with "channel closed". That's
 * expected end-of-session noise, not an error — swallow it, surface the
 * rest.
 */
function quietIfClosed(e: unknown): void {
  const msg = String(e);
  if (msg.includes("channel closed") || msg.includes("session not found")) {
    return;
  }
  console.error(e);
}

/** Regex bank for common shell prompts. Tested in order. */
const PROMPT_PATTERNS: RegExp[] = [
  /^([\w.-]+@[\w.-]+:[^$#]*[$#])\s+(\S.*)$/, // user@host:~$ cmd
  /^(PS [^>]+>)\s+(\S.*)$/, // PS C:\path> cmd
  /^([A-Z]:\\[^>]*>)\s*(\S.*)$/, // C:\path>cmd (cmd.exe doesn't always have a space)
  /^(>)\s+(\S.*)$/, // generic >
];

/** Index in `lines` of the latest line that looks like "<prompt> <command>". */
function findLastCommandLine(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    for (const pat of PROMPT_PATTERNS) {
      const m = line.match(pat);
      if (m && m[2] && m[2].trim().length > 0) {
        return i;
      }
    }
  }
  return -1;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { sessionId, initialBytes, xtermTheme, onClosed, onAskSelection },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  // Capture initialBytes on first mount only; later updates shouldn't replay.
  const initialBytesRef = useRef(initialBytes);
  // Keep onClosed in a ref so changing the prop doesn't tear down xterm.
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  // Throttle the "buffer empty but should have content" warning to once per minute.
  const lastWarnRef = useRef(0);
  const [hasSelection, setHasSelection] = useState(false);

  // Apply theme changes without rebuilding xterm. xterm.js supports live
  // theme updates via the options setter.
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = xtermTheme;
    }
  }, [xtermTheme]);

  useImperativeHandle(ref, () => ({
    getLastLines(n: number): string[] {
      const xterm = xtermRef.current;
      if (!xterm) return [];

      // Try both buffers — Windows ConPTY sometimes writes to the alternate
      // screen even for ordinary cmd.exe output.
      const readFrom = (b: typeof xterm.buffer.active): string[] => {
        const out: string[] = [];
        const start = Math.max(0, b.length - n);
        for (let i = start; i < b.length; i++) {
          const line = b.getLine(i);
          if (line) out.push(line.translateToString(true));
        }
        while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
        return out;
      };

      let lines = readFrom(xterm.buffer.active);

      // Fallback: if active buffer looks empty but the inactive one has
      // content, use that instead.
      if (lines.length === 0) {
        const other =
          xterm.buffer.active === xterm.buffer.normal
            ? xterm.buffer.alternate
            : xterm.buffer.normal;
        const fallback = readFrom(other);
        if (fallback.length > 0) {
          lines = fallback;
        }
      }

      // If we STILL got nothing but the active buffer has rows, log
      // diagnostics so we can debug Windows/ConPTY edge cases.
      if (lines.length === 0 && xterm.buffer.active.length > 0) {
        const now = Date.now();
        if (now - lastWarnRef.current > 60_000) {
          lastWarnRef.current = now;
          const buf = xterm.buffer.active;
          const sample: Array<{ i: number; text: string; len: number }> = [];
          const sampleIdxs = [
            0,
            1,
            Math.floor(buf.length / 2),
            buf.length - 3,
            buf.length - 2,
            buf.length - 1,
          ].filter((i) => i >= 0 && i < buf.length);
          for (const i of sampleIdxs) {
            const line = buf.getLine(i);
            if (line) {
              const raw = line.translateToString(false);
              sample.push({ i, text: raw, len: raw.length });
            }
          }
          console.warn("[sshade.terminal] getLastLines returned empty", {
            activeIsAlternate: xterm.buffer.active === xterm.buffer.alternate,
            bufferLength: buf.length,
            cols: xterm.cols,
            rows: xterm.rows,
            cursorX: buf.cursorX,
            cursorY: buf.cursorY,
            viewportY: buf.viewportY,
            baseY: buf.baseY,
            sample,
          });
        }
      }

      return lines;
    },
    getLastCommandOutput(): string[] {
      const xterm = xtermRef.current;
      if (!xterm) return [];
      const buf = xterm.buffer.active;
      const all: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) all.push(line.translateToString(true));
      }
      // Drop trailing empties so the final prompt isn't padded by blank rows.
      while (all.length > 0 && all[all.length - 1].trim() === "") all.pop();
      const start = findLastCommandLine(all);
      if (start < 0) {
        // No prompt found — fall back to last 30 lines.
        return all.slice(-30);
      }
      return all.slice(start);
    },
    focus() {
      xtermRef.current?.focus();
    },
    pasteCommand(cmd: string) {
      // No trailing newline — the user can edit and press Enter themselves.
      const text = cmd.replace(/\r?\n+$/, "");
      const bytes = Array.from(new TextEncoder().encode(text));
      sshSendInput(sessionId, bytes).catch(quietIfClosed);
      xtermRef.current?.focus();
    },
    runCommand(cmd: string) {
      // Enter is carriage return (\r), not LF. POSIX PTYs map CR→NL via the
      // line discipline; Windows sshd/ConPTY only acts on \r. Sending \n
      // (the old behaviour) just inserted a newline on Windows — the
      // command pasted but never ran.
      const text = cmd.replace(/[\r\n]+$/, "") + "\r";
      const bytes = Array.from(new TextEncoder().encode(text));
      sshSendInput(sessionId, bytes).catch(console.error);
      xtermRef.current?.focus();
    },
  }));

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const xterm = new XTerm({
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      allowProposedApi: true,
      theme: xtermTheme,
    });
    xtermRef.current = xterm;

    // Let Ctrl/Cmd+K bubble to the window (opens QuickAsk) instead of being
    // sent to the remote shell as readline kill-line. Trade-off: kill-line
    // via Ctrl+K is shadowed inside the app (Ctrl+U still works in-shell).
    xterm.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        return false; // xterm ignores it; the DOM event still propagates
      }
      return true;
    });

    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host);
    fit.fit();

    // Replay the bytes the backend captured before our listener was ready
    // (login banner + initial prompt). Do this BEFORE subscribing so the
    // ordering with live events is preserved.
    const initial = initialBytesRef.current;
    if (initial && initial.length > 0) {
      xterm.write(new Uint8Array(initial));
    }

    const inputDisposable = xterm.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      sshSendInput(sessionId, bytes).catch(quietIfClosed);
    });

    const selDisposable = xterm.onSelectionChange(() => {
      setHasSelection(xterm.hasSelection());
    });

    // Standard terminal UX: finishing a selection copies it (like
    // PuTTY/xterm). onSelectionChange fires continuously while dragging,
    // so copy on mouseup instead — once, when the selection is final.
    // Uses the native Tauri clipboard (not navigator.clipboard, which
    // WebView2 blocks on Windows).
    const onMouseUp = () => {
      const sel = xterm.getSelection();
      if (sel) {
        writeText(sel).catch((e) =>
          console.debug("[sshade.term] copy failed", e),
        );
      }
    };
    host.addEventListener("mouseup", onMouseUp);

    // Right-click pastes (PuTTY-style) — no menu, no left-click + Paste.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      readText()
        .then((text) => {
          if (!text) return;
          const bytes = Array.from(new TextEncoder().encode(text));
          sshSendInput(sessionId, bytes).catch(quietIfClosed);
          xterm.focus();
        })
        .catch((err) => console.debug("[sshade.term] paste failed", err));
    };
    host.addEventListener("contextmenu", onContextMenu);

    const dataUnlisten = onSshData((evt) => {
      if (evt.session_id !== sessionId) return;
      xterm.write(b64ToBytes(evt.data));
    });

    const closedUnlisten = onSshClosed((evt) => {
      if (evt.session_id !== sessionId) return;
      onClosedRef.current(evt.reason);
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      sshResize(sessionId, xterm.cols, xterm.rows).catch(quietIfClosed);
    });
    resizeObserver.observe(host);

    xterm.focus();

    return () => {
      inputDisposable.dispose();
      selDisposable.dispose();
      host.removeEventListener("mouseup", onMouseUp);
      host.removeEventListener("contextmenu", onContextMenu);
      resizeObserver.disconnect();
      dataUnlisten.then((un) => un());
      closedUnlisten.then((un) => un());
      xterm.dispose();
      xtermRef.current = null;
    };
    // `onClosed` is intentionally NOT in deps — it changes every render in
    // the parent, and re-running this effect would tear down xterm (focus
    // jumps, content loss). We access it via onClosedRef to always call the
    // latest version.
  }, [sessionId]);

  return (
    <div className="terminal-frame">
      <div ref={containerRef} className="terminal-host" />
      {hasSelection && onAskSelection && (
        <button
          type="button"
          className="terminal-sel-ask"
          // Keep the xterm selection alive through the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const sel = xtermRef.current?.getSelection() ?? "";
            if (sel.trim()) onAskSelection(sel.split(/\r?\n/));
          }}
        >
          <Sparkles size={13} strokeWidth={1.75} />
          Ask AI about selection
        </button>
      )}
    </div>
  );
});
