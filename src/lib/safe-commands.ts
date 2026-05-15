/**
 * Classifier for "is this command safe to auto-run without asking?".
 *
 * Security stance: deny by default. A command is auto-approvable ONLY if
 * every piped segment's leading binary is on a hand-picked read-only
 * allow-list AND the string contains no shell construct that could chain,
 * redirect, or substitute its way into a mutation. Anything uncertain
 * falls through to manual approval — the gate is the safe default, this
 * is just an opt-in shortcut for obvious diagnostics (ls, cat, ps…).
 *
 * This is intentionally conservative: false negatives (a safe command the
 * user still has to approve) are fine; false positives are not.
 */

/** Read-only binaries that cannot mutate state with ordinary usage. */
const SAFE_BINS = new Set([
  "ls", "pwd", "whoami", "id", "hostname", "uname", "uptime", "date",
  "df", "du", "free", "ps", "env", "printenv", "echo", "printf",
  "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg",
  "sort", "uniq", "cut", "tr", "stat", "file", "readlink",
  "basename", "dirname", "which", "type", "nproc", "arch",
  "lsblk", "lscpu", "lsof", "ss", "netstat", "ip", "dig",
  "nslookup", "host", "getent", "journalctl", "dmesg", "w",
  "last", "vmstat", "true", "test",
]);

/**
 * Shell constructs that can branch a "safe" command into a mutating one:
 * command sequencing, background, redirection (file write), here-docs,
 * command/process substitution, backticks. Pipes (`|`) are allowed and
 * validated segment-by-segment.
 */
const DANGEROUS = /[;&><`\n]|\$\(|\|\||&&|\bsudo\b|\bdoas\b/;

/** Returns true only when the command is provably read-only. */
export function isSafeCommand(raw: string): boolean {
  const cmd = raw.trim();
  if (!cmd) return false;
  if (DANGEROUS.test(cmd)) return false;

  // Every pipe segment must independently start with a safe binary.
  for (const seg of cmd.split("|")) {
    const tokens = seg.trim().split(/\s+/);
    // Skip leading `VAR=value` assignments (harmless prefix, e.g. LC_ALL=C grep).
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const head = tokens[i];
    if (!head) return false;
    // Reject path-qualified binaries (./x, /usr/bin/x) — keep it to the
    // PATH-resolved allow-list so the classifier stays predictable.
    const bin = head.includes("/") ? "" : head;
    if (!SAFE_BINS.has(bin)) return false;
    // `find` deliberately excluded: -exec/-delete make it write-capable.
  }
  return true;
}
