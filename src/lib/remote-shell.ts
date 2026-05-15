/**
 * Best-effort detection of the remote shell family from what the terminal
 * has already printed (banner + prompt). The agent's sentinel protocol and
 * command vocabulary differ per shell, so we sniff before driving it.
 *
 * Heuristic, not authoritative: if unsure we fall back to "posix" (the
 * common case). The agent prompt also tells the model what we detected so
 * it generates the right commands (dir vs ls, etc.).
 */

export type ShellFamily = "posix" | "cmd" | "powershell";

export function detectShell(lines: string[]): ShellFamily {
  const blob = lines.join("\n");

  // PowerShell prompt: "PS C:\Users\x>" or "PS /home/x>".
  if (/(^|\n)\s*PS [A-Za-z]?:?[\\/][^\n]*>\s*$/m.test(blob)) {
    return "powershell";
  }
  // cmd.exe: the classic banner, or a "C:\Users\x>" drive-letter prompt.
  if (
    /Microsoft Windows \[/i.test(blob) ||
    /(^|\n)[A-Za-z]:\\[^\n]*>\s*$/m.test(blob)
  ) {
    return "cmd";
  }
  return "posix";
}

export interface Sentinel {
  /** Lines to submit (each followed by CR). The last produces the marker. */
  lines: string[];
  /** Matches the marker line; capture group 1 is the exit code. */
  re: RegExp;
}

/**
 * Build the exit-code sentinel for a shell.
 *
 * Windows uses a SECOND submitted line for the marker on purpose: in
 * interactive cmd.exe `%ERRORLEVEL%` in a `A & echo %ERRORLEVEL%` compound
 * line is expanded at parse time (before A runs) — stale. Submitting the
 * echo as its own line makes it reflect the real prior exit code.
 */
export function buildSentinel(
  command: string,
  nonce: string,
  shell: ShellFamily,
): Sentinel {
  const tag = `__SSHADE_E${nonce}_`;
  const re = new RegExp(`${tag}(-?\\d+)__`);
  switch (shell) {
    case "cmd":
      return {
        lines: [command, `echo ${tag}%ERRORLEVEL%__`],
        re,
      };
    case "powershell":
      return {
        lines: [
          command,
          // $ok/$c captured FIRST — anything else clobbers $? / $LASTEXITCODE.
          // Sent as its own line so they reflect <command>, not this line.
          `$ok=$?; $c=$LASTEXITCODE; if($null -eq $c){if($ok){$c=0}else{$c=1}}; ` +
            `Write-Output "${tag}$c__"`,
        ],
        re,
      };
    default:
      // POSIX: one line; `$?` right after `;` is <command>'s status.
      return {
        lines: [`${command}; printf '\\n${tag}%s__\\n' "$?"`],
        re,
      };
  }
}
