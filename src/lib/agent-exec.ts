/**
 * Sentinel-based command capture over the *visible* PTY.
 *
 * The agent runs commands in the same terminal the user watches (option C).
 * To know when a command finished and its exit code, we append a marker
 * whose exact form depends on the remote shell (see remote-shell.ts):
 * POSIX `printf … "$?"`, cmd.exe `echo %ERRORLEVEL%`, PowerShell
 * `$LASTEXITCODE`.
 *
 * A passive listener on the `ssh:data` stream (the same one xterm renders
 * from — we don't interfere with it) accumulates output until the marker
 * appears, then extracts the command output + exit code.
 *
 * Limitations (mitigated by the agent system prompt):
 * - Non-interactive commands only. `vim`, bare `top`, pagers will hang
 *   waiting for the marker — the timeout + abort are the safety net.
 * - The marker line is briefly visible in the terminal. OSC 133 (invisible)
 *   is a future upgrade.
 */

import { type ShellFamily, buildSentinel } from "./remote-shell";
import { b64ToBytes, onSshData, sshSendInput } from "./ssh";

/** The exit-code marker is always at the very end of the output, so we
 *  only ANSI-strip + scan this much tail per event instead of the whole
 *  growing buffer (was O(n²) over a command's total output). */
const MARKER_SCAN_TAIL = 8192;

// Strip ANSI / control sequences so marker detection and the text fed to
// the model are clean (the user still sees colors in xterm — untouched).
// eslint-disable-next-line no-control-regex
const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export interface CapturedResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
}

export interface CaptureOpts {
  signal?: AbortSignal;
  /** Hard cap before we give up waiting for the marker. Default 60s. */
  timeoutMs?: number;
  /** Remote shell — picks the sentinel syntax. Default "posix". */
  shell?: ShellFamily;
}

export function runCapturedCommand(
  sessionId: string,
  command: string,
  opts: CaptureOpts = {},
): Promise<CapturedResult> {
  const nonce = Math.random().toString(36).slice(2, 10);
  const sentinel = buildSentinel(command, nonce, opts.shell ?? "posix");
  const markerRe = sentinel.re;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise<CapturedResult>((resolve) => {
    let raw = "";
    let settled = false;
    let unlisten: (() => void) | null = null;
    const unlistenPromise = onSshData((evt) => {
      if (evt.session_id !== sessionId) return;
      raw += new TextDecoder().decode(b64ToBytes(evt.data));
      // Cheap per-event check: strip + scan only the tail.
      const tail =
        raw.length > MARKER_SCAN_TAIL ? raw.slice(-MARKER_SCAN_TAIL) : raw;
      if (markerRe.test(stripAnsi(tail))) {
        // Marker found — now do the full strip ONCE to extract output.
        const clean = stripAnsi(raw);
        const m = clean.match(markerRe);
        const exitCode = m ? Number.parseInt(m[1], 10) : -1;
        let out = clean.slice(0, m?.index ?? clean.length);
        out = stripEchoedCommand(out, command).trim();
        finish({ output: out, exitCode, timedOut: false });
      }
    });
    unlistenPromise.then((u) => {
      unlisten = u;
      if (settled) u(); // settled before listener resolved — clean up now
    });

    const timer = setTimeout(() => {
      finish({
        output: stripEchoedCommand(stripAnsi(raw), command).trim(),
        exitCode: -1,
        timedOut: true,
      });
    }, timeoutMs);

    function onAbort() {
      finish({
        output: stripEchoedCommand(stripAnsi(raw), command).trim(),
        exitCode: -1,
        timedOut: true,
      });
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    function finish(r: CapturedResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (unlisten) unlisten();
      else unlistenPromise.then((u) => u());
      resolve(r);
    }

    // Submit each sentinel line followed by CR (Enter). CR — not LF — is
    // what a terminal sends on Enter; POSIX PTYs map CR→NL, Windows only
    // acts on CR.
    const payload = sentinel.lines.map((l) => `${l}\r`).join("");
    const bytes = Array.from(new TextEncoder().encode(payload));
    sshSendInput(sessionId, bytes).catch((e) => {
      finish({ output: `failed to send command: ${e}`, exitCode: -1, timedOut: false });
    });
  });
}

/** Drop the first line if it's the echoed command we just sent. */
function stripEchoedCommand(text: string, command: string): string {
  const nl = text.indexOf("\n");
  if (nl === -1) return text;
  const first = text.slice(0, nl);
  // The echoed line is "<prompt> <command>; printf …" — if it contains the
  // command, drop that whole first line.
  if (first.includes(command.slice(0, Math.min(command.length, 40)))) {
    return text.slice(nl + 1);
  }
  return text;
}
