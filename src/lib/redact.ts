/**
 * Redact secrets from terminal output before it's sent to an AI provider.
 *
 * The terminal context can contain anything the user ran — `cat .env`,
 * `aws configure`, an exported token. We never want that leaving the
 * machine in cleartext inside a prompt. This is best-effort defence in
 * depth, not a guarantee: patterns evolve, so the user is still warned in
 * the UI that context is sent.
 */

interface Rule {
  name: string;
  re: RegExp;
  /** Build the replacement; `m` is the full match. */
  replace: (m: string) => string;
}

const RULES: Rule[] = [
  // Multi-line private key blocks (PEM / OpenSSH).
  {
    name: "private-key",
    re: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED:private-key]",
  },
  // Anthropic keys (check before generic sk- so the longer prefix wins).
  {
    name: "anthropic-key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    replace: () => "[REDACTED:anthropic-key]",
  },
  // OpenAI / generic sk- keys.
  {
    name: "openai-key",
    re: /\bsk-[A-Za-z0-9]{20,}/g,
    replace: () => "[REDACTED:api-key]",
  },
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_).
  {
    name: "github-token",
    re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/g,
    replace: () => "[REDACTED:github-token]",
  },
  // AWS access key id.
  {
    name: "aws-akid",
    re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => "[REDACTED:aws-access-key]",
  },
  // JWTs.
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: () => "[REDACTED:jwt]",
  },
  // Bearer / Authorization header values.
  {
    name: "bearer",
    re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
    replace: () => "Bearer [REDACTED]",
  },
  // URLs with embedded credentials  scheme://user:pass@host
  {
    name: "url-creds",
    re: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi,
    replace: (m) => m.replace(/:[^\s@]+@$/, ":[REDACTED]@"),
  },
  // Shell/env style assignments of obviously-secret variables.
  {
    name: "env-secret",
    re: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/g,
    replace: (m) =>
      m.replace(/([:=]\s*)(.+)$/, (_s, sep) => `${sep}[REDACTED]`),
  },
];

export interface RedactResult {
  text: string;
  /** Counts per rule that fired, for an optional UI hint. */
  hits: Record<string, number>;
  total: number;
}

export function redactSecrets(input: string): RedactResult {
  let text = input;
  const hits: Record<string, number> = {};
  let total = 0;

  for (const rule of RULES) {
    text = text.replace(rule.re, (m) => {
      hits[rule.name] = (hits[rule.name] ?? 0) + 1;
      total += 1;
      return rule.replace(m);
    });
  }

  return { text, hits, total };
}

/** Redact an array of lines, returning the cleaned lines + total hit count. */
export function redactLines(lines: string[]): {
  lines: string[];
  total: number;
} {
  const joined = lines.join("\n");
  const { text, total } = redactSecrets(joined);
  return { lines: text.split("\n"), total };
}
