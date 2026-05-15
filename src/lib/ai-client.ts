/**
 * Unified streaming AI client. Dispatches to the right provider via Vercel
 * AI SDK adapters. The user's key never leaves the machine — calls go
 * straight from the WebView to the provider.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, type ModelMessage } from "ai";

import type { ProviderConfig } from "./ai-settings";
import { PROVIDERS, type ProviderId } from "./providers";
import { redactLines } from "./redact";
import { type ShellFamily, detectShell } from "./remote-shell";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamOpts {
  providerId: ProviderId;
  config: ProviderConfig;
  history: AiMessage[];
  contextLines: string[];
  question: string;
  onDelta: (chunk: string) => void;
  signal?: AbortSignal;
}

const STREAM_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 15_000;

/**
 * Max prior turns resent to the model. These APIs are stateless — the
 * whole history rides along every request, so an uncapped conversation
 * grows the token bill every turn. A sliding window keeps recent context
 * (enough for follow-ups) while bounding cost.
 */
export const MAX_HISTORY_MESSAGES = 16;

/**
 * Prepare conversation history for the wire: drop empty/structured slots
 * (agent plan/step cards carry their data in side fields, not `content`,
 * so they'd otherwise go as wasted empty assistant turns), keep only the
 * last MAX_HISTORY_MESSAGES, and never lead with an assistant turn (the
 * providers reject that).
 */
export function trimHistory(
  history: { role: "user" | "assistant"; content: string }[],
): { role: "user" | "assistant"; content: string }[] {
  const nonEmpty = history.filter((m) => m.content.trim().length > 0);
  const tail = nonEmpty.slice(-MAX_HISTORY_MESSAGES);
  let i = 0;
  while (i < tail.length && tail[i].role !== "user") i++;
  return tail.slice(i).map((m) => ({ role: m.role, content: m.content }));
}

const COMPACT_SYSTEM_PROMPT = `You compress an SSH troubleshooting conversation into a dense FACTUAL summary that will REPLACE the older messages while keeping continuity.

Preserve as terse bullets (only what LITERALLY appeared — never invent):
- Server / OS / shell, hostnames, paths, versions in play.
- What was investigated and what was concluded.
- Commands that were run and their key results / exit codes.
- Decisions made and the reason.
- Unresolved problems and the next steps.

Rules:
- Facts only. If something is unknown, omit it — do not guess.
- No pleasantries, no narration. Bullets, not prose.
- Never reproduce secrets; write "<redacted>" if one appears.
- Output ONLY the summary.`;

/**
 * Condense a conversation into a factual summary so it can replace the
 * older turns (user-triggered "compact"). Non-streaming — the result is
 * one message, not a live answer.
 */
export async function summarizeChat(opts: {
  providerId: ProviderId;
  config: ProviderConfig;
  history: { role: "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
}): Promise<string> {
  const model = buildLanguageModel(opts.providerId, opts.config);
  const { lines } = redactLines(
    opts.history
      .filter((m) => m.content.trim().length > 0)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`),
  );
  const convo = lines.join("\n\n");
  const timeoutSignal = AbortSignal.timeout(STREAM_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  const res = await generateText({
    model,
    system: COMPACT_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: `Summarize this conversation:\n\n${convo}` },
    ],
    abortSignal: signal,
  });
  return (res.text ?? "").trim();
}

// Only the rule for the detected shell is sent — not a generic table of
// every shell. Fewer tokens AND a sharper prompt: the model isn't told
// Windows rules while you're on Linux (or vice-versa), which is where
// wrong-OS command suggestions come from.
const SHELL_FENCE: Record<ShellFamily, string> = {
  posix: `  - The remote shell is a POSIX shell (Linux/macOS). Use a \`\`\`bash fence (or \`\`\`zsh / \`\`\`fish if that exact shell shows in the prompt). Standard Unix tooling applies. Example:
    \`\`\`bash
    systemctl status nginx
    \`\`\``,
  cmd: `  - The remote shell is Windows cmd.exe. Use a \`\`\`cmd fence. Unix tools DO NOT EXIST here — no \`ls\`/\`cat\`/\`grep\`/\`touch\`/\`printf\`/\`;\`. Use \`dir\`, \`type\`, \`findstr\`, \`tasklist\`, \`sc query\`, \`ipconfig\`; chain with \`&\`. Example:
    \`\`\`cmd
    dir /a
    \`\`\``,
  powershell: `  - The remote shell is Windows PowerShell. Use a \`\`\`powershell fence and cmdlets — \`Get-ChildItem\`, \`Get-Content\`, \`Select-String\`, \`Get-Service\`, \`Get-Process\`. Statement separator is \`;\`. Example:
    \`\`\`powershell
    Get-Service nginx
    \`\`\``,
};

function buildSystemPrompt(shell: ShellFamily): string {
  return `You are sshade's AI assistant — a senior SRE / DevOps engineer embedded inside an SSH terminal client.

# Context you receive
The user is connected to a remote server via SSH. With each question they send you:
- Their natural-language question or request
- A <terminal_context> block with the most recent lines of their terminal session (commands they ran AND the output they saw)

The context is raw — it includes the shell prompt, command typed, output, exit codes, and possibly partial lines. Treat it as ground truth about the live system state.

# CRITICAL: anti-hallucination rules
The <terminal_context> block is your ONLY source of truth about the user's system. You have ZERO access to anything else.

- NEVER invent hostnames, usernames, IP addresses, OS versions, kernel versions, distribution names, file paths, process IDs, port numbers, package versions, or any other concrete factual details. If it does not appear LITERALLY in the terminal_context, you do not know it.
- If asked "what do you see in my terminal?" or similar, quote EXACTLY what's in the terminal_context. Do not embellish. Do not add details. If only the shell prompt is visible (e.g. \`user@host:~$\` with no commands), say only that and tell them to run a command first.
- If the terminal_context is missing, empty, or contains only blank lines or just a prompt: say "Your terminal context appears empty (only a shell prompt / no commands yet). Run a command and ask again." Do NOT make up content.
- The PROMPT itself contains real info you CAN cite: in \`ubuntu@web-01:/var/log$\` the user is "ubuntu", host is "web-01", cwd is "/var/log". Quote what's actually there — never substitute fabricated values.
- If the user's question requires info you cannot find in the context, ask for the diagnostic command output instead of guessing.

# How to answer
- Be DENSE and ACTIONABLE. Sysadmins value brevity above prose. No filler, no "Great question!", no recapping the obvious.
- Lead with the most likely cause or the next concrete step. Explain after.
- **Code block rules** (CRITICAL — the UI renders a "Run" button on every fenced shell block):
  - For a shell command the user might RUN — even a single line — use a fenced code block. The UI surfaces a Run button only on fenced blocks, NEVER on inline backticks.
${SHELL_FENCE[shell]}
  - For multi-line scripts use the same fence with all lines.
  - ONE runnable block = ONE self-contained action. Never put a *menu* of alternatives, prose, or \`#\` comments inside a fenced block — Run executes the whole block verbatim. If you have alternatives, write each as its OWN separate fenced block with the explanation as prose BETWEEN them, not inside.
  - NEVER put \`exit\`, \`logout\`, or anything that ends the SSH session inside a runnable block — it kills the user's terminal. Describe it in prose if relevant.
  - Default to NON-INTERACTIVE commands that terminate on their own — Run does paste+Enter and the terminal blocks until the command returns. Prefer: \`docker logs --tail 200 X\` (not \`-f\`), \`journalctl -u X --no-pager -n 200\` (not bare \`journalctl\`), \`top -bn1\` (not \`top\`), \`cat\`/\`sed -n\` (not \`less\`/\`vim\`/\`man\`), \`ps aux\` (not \`htop\`).
  - EXCEPTION — honor explicit intent: if the user explicitly asks for a follow/watch/interactive command (e.g. "tail -f", "watch it live", "open vim", "dame el comando interactivo"), give exactly that, in its own block, and add a one-line note that it runs until Ctrl+C / is interactive so they know the terminal stays attached. Don't downgrade what they explicitly asked for.
  - Use single backticks ONLY to cite values that are NOT meant to be executed: paths, filenames, PIDs, env vars, model names, hostnames, IPs. Examples: \`/var/log/syslog\`, \`PID 1234\`, \`$HOME\`, \`C:\\Users\\joel\`, \`gpt-4o-mini\`.
- If you need diagnostic info you can't infer from the context, propose the SINGLE BEST command to gather it and STOP — don't speculate further.
- If a destructive command is needed (\`rm\`, \`dd\`, \`mkfs\`, force-killing prod, \`DROP TABLE\`, etc.), put a brief WARNING line first and require explicit confirmation.
- Reply in the user's language (English or Spanish — detect from the question).

# Style
- Use lists, tables, and code blocks liberally — they scan faster than paragraphs.
- Keep prose short. A two-sentence intro is usually too long.
- When citing a line from the context, quote the relevant fragment exactly with backticks.

# Things you do NOT do
- You do not execute commands. You suggest them; the user runs them.
- You do not have access to anything outside the terminal_context the user sends.
- You do not reveal or speculate about secrets even if they appear in the context — warn and recommend rotating.
- You do not write essays.

Begin.`;
}

export function buildLanguageModel(
  providerId: ProviderId,
  config: ProviderConfig,
) {
  const meta = PROVIDERS[providerId];
  const baseURL = config.baseURL || meta.defaultBaseURL;

  switch (providerId) {
    case "anthropic": {
      const client = createAnthropic({
        apiKey: config.apiKey,
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      });
      return client(config.model);
    }
    case "google": {
      const client = createGoogleGenerativeAI({ apiKey: config.apiKey });
      return client(config.model);
    }
    case "openai":
    case "deepseek":
    case "nvidia":
    case "groq":
    case "ollama":
    case "custom": {
      const client = createOpenAI({
        apiKey: config.apiKey || "ollama-no-key",
        baseURL,
      });
      return client(config.model);
    }
  }
}

/** Convert raw provider errors into something users can act on. */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes("aborterror") || lower.includes("aborted") || lower.includes("timed out") || lower.includes("timeout")) {
    return "Timed out — provider didn't respond. Often means CORS is blocking the request (check the WebView console: right-click → Inspect → Console tab) or the network is down.";
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "Network error — likely CORS rejection from the provider, or the baseURL is unreachable. Check the WebView console.";
  }
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("invalid api key")) {
    return "Invalid API key (401). Re-check it in Settings.";
  }
  if (lower.includes("403") || lower.includes("forbidden")) {
    return "Forbidden (403) — key may lack permission for this model.";
  }
  if (lower.includes("404") || lower.includes("not found") || lower.includes("model not found")) {
    return "Model not found (404). The model name may be wrong for this provider.";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "Rate limited (429). Wait a bit or upgrade the plan.";
  }
  if (lower.includes("500") || lower.includes("502") || lower.includes("503")) {
    return `Provider is having issues (${msg}). Try again or switch provider.`;
  }
  return msg;
}

export async function streamAi(opts: StreamOpts): Promise<string> {
  const model = buildLanguageModel(opts.providerId, opts.config);

  // Strip anything that looks like a credential before it leaves the
  // machine. Best-effort defence in depth.
  const { lines: safeLines, total: redactedCount } = redactLines(
    opts.contextLines,
  );

  // Detect the remote shell from the captured prompt/banner so the system
  // prompt carries only that OS's command rules (sharper + cheaper). No
  // context → defaults to posix, the common case.
  const shell = detectShell(opts.contextLines);

  const contextBlock =
    safeLines.length > 0
      ? `\n\n<terminal_context>\n${safeLines.join("\n")}\n</terminal_context>`
      : "";

  const userContent = opts.question + contextBlock;
  const history = trimHistory(opts.history);
  const messages: ModelMessage[] = [
    ...history.map((m) => ({ role: m.role, content: m.content }) as ModelMessage),
    { role: "user", content: userContent },
  ];

  // Metadata only — never log the prompt contents (would mirror the
  // terminal, secrets included, into the WebView console).
  console.debug("[sshade.ai] sending", {
    providerId: opts.providerId,
    model: opts.config.model,
    shell,
    historyTurns: history.length,
    historyDropped: opts.history.length - history.length,
    contextLineCount: opts.contextLines.length,
    redactedSecrets: redactedCount,
  });

  // Compose user-passed AbortController with a hard timeout so the UI never
  // hangs silently when a provider stops responding.
  const timeoutSignal = AbortSignal.timeout(STREAM_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  const result = streamText({
    model,
    system: buildSystemPrompt(shell),
    messages,
    abortSignal: signal,
  });

  let full = "";
  try {
    for await (const chunk of result.textStream) {
      full += chunk;
      opts.onDelta(chunk);
    }
  } catch (err) {
    console.error("[sshade.ai] stream failed", {
      providerId: opts.providerId,
      model: opts.config.model,
      error: err,
    });
    throw new Error(friendlyError(err));
  }
  return full;
}

/**
 * Sanity-check a provider config with a single, non-streaming "say ok" call.
 * Returns a structured result so the UI can show ✓/⚠ inline.
 */
export interface TestResult {
  ok: boolean;
  message: string;
  /** The reply text if successful, for the user to verify the model echoed something. */
  reply?: string;
}

export async function testProvider(
  providerId: ProviderId,
  config: ProviderConfig,
): Promise<TestResult> {
  try {
    const model = buildLanguageModel(providerId, config);
    const res = await generateText({
      model,
      prompt: "Reply with exactly: ok",
      abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const reply = (res.text ?? "").trim();
    if (!reply) {
      return {
        ok: false,
        message: "Connected but received an empty response. Try a different model.",
      };
    }
    return { ok: true, message: "Connected", reply };
  } catch (err) {
    console.error("[sshade.ai] test failed", {
      providerId,
      model: config.model,
      error: err,
    });
    return { ok: false, message: friendlyError(err) };
  }
}

/**
 * Ask the provider which models the current API key can use. Most providers
 * implement an OpenAI-style `/v1/models`; Anthropic and Google have their own.
 * Returns the list sorted alphabetically.
 */
export async function fetchModels(
  providerId: ProviderId,
  config: ProviderConfig,
): Promise<string[]> {
  const meta = PROVIDERS[providerId];
  const baseURL = config.baseURL || meta.defaultBaseURL;
  const timeout = AbortSignal.timeout(15_000);

  try {
    switch (providerId) {
      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          signal: timeout,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const json = (await res.json()) as { data?: Array<{ id: string }> };
        return (json.data ?? []).map((m) => m.id).sort();
      }

      case "google": {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.apiKey)}`;
        const res = await fetch(url, { signal: timeout });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const json = (await res.json()) as {
          models?: Array<{
            name: string;
            supportedGenerationMethods?: string[];
          }>;
        };
        return (json.models ?? [])
          .filter((m) =>
            (m.supportedGenerationMethods ?? []).includes("generateContent"),
          )
          .map((m) => m.name.replace(/^models\//, ""))
          .sort();
      }

      case "openai":
      case "deepseek":
      case "nvidia":
      case "groq":
      case "ollama":
      case "custom": {
        if (!baseURL) throw new Error("Missing base URL");
        const url = `${baseURL.replace(/\/$/, "")}/models`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${config.apiKey || "ollama-no-key"}`,
          },
          signal: timeout,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const json = (await res.json()) as { data?: Array<{ id: string }> };
        return (json.data ?? []).map((m) => m.id).sort();
      }
    }
  } catch (err) {
    console.error("[sshade.ai] fetchModels failed", {
      providerId,
      error: err,
    });
    throw new Error(friendlyError(err));
  }
}
