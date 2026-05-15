/**
 * Agent loop. The model is given a `runCommand` tool; the Vercel AI SDK
 * drives the tool-use loop for us (call model → it requests a command →
 * we run it via the sentinel capturer on the visible PTY → feed the
 * result back → repeat until done or the step cap).
 *
 * Every command requires explicit user approval (`requestApproval`).
 * Captured output is redacted before it goes back to the model.
 */

import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { runCapturedCommand } from "./agent-exec";
import type { ShellFamily } from "./remote-shell";
import { buildLanguageModel, trimHistory } from "./ai-client";
import type { ProviderConfig } from "./ai-settings";
import type { ProviderId } from "./providers";
import { redactLines } from "./redact";

export type AgentApproval = "run" | "skip" | "abort";

export interface AgentStep {
  command: string;
  output: string;
  exitCode: number;
  timedOut: boolean;
  skipped: boolean;
}

export interface RunAgentOpts {
  providerId: ProviderId;
  config: ProviderConfig;
  /** SSH session id of the active tab — null means no terminal to drive. */
  sessionId: string | null;
  /** Detected remote shell — drives sentinel syntax + command vocabulary. */
  shell: ShellFamily;
  history: { role: "user" | "assistant"; content: string }[];
  goal: string;
  maxSteps?: number;
  signal: AbortSignal;
  /** UI gate — resolves when the user picks Run / Skip / Abort. */
  requestApproval: (command: string) => Promise<AgentApproval>;
  /** Streamed reasoning text from the model. */
  onText: (delta: string) => void;
  /** A finished (or skipped) command step. */
  onStep: (step: AgentStep) => void;
  /** The agent's up-front plan (2–6 short imperative steps). */
  onPlan: (steps: string[]) => void;
}

const SHELL_GUIDANCE: Record<ShellFamily, string> = {
  posix: `# Environment
The remote shell is a POSIX shell (bash/sh) on Linux/macOS. Use Unix commands (\`ls\`, \`cat\`, \`grep\`, \`ps aux\`, \`systemctl\`). Chain inseparable steps with \`&&\`.`,
  cmd: `# Environment
The remote shell is Windows **cmd.exe** — NOT a POSIX shell. There is no \`ls\`, \`cat\`, \`grep\`, \`touch\`, \`printf\`, \`;\`, or \`$?\`. Use Windows commands: \`dir\`, \`type\`, \`findstr\`, \`tasklist\`, \`sc query\`, \`ipconfig\`, \`systeminfo\`, \`echo. > file\` to create a file, \`echo text >> file\` to append. Chain with \`&\` (or \`&&\`). Paths use backslashes. Do NOT emit Unix syntax — it will error.`,
  powershell: `# Environment
The remote shell is Windows **PowerShell**. Use cmdlets: \`Get-ChildItem\`, \`Get-Content\`, \`Select-String\`, \`Get-Process\`, \`Get-Service\`, \`New-Item -ItemType File\`, \`Add-Content\`, \`Test-Path\`. Statement separator is \`;\`. Avoid Unix tool names unless you know an alias exists.`,
};

const AGENT_SYSTEM_PROMPT = `You are sshade's agent — a senior systems engineer operating a remote server through one SSH session, step by step, with the human approving every command.

# Tools
1. \`setPlan(steps)\` — call this ONCE, FIRST, before anything else. Pass 2–6 short imperative steps (e.g. "Check nginx service status"). This renders a checklist the user watches tick off.
2. \`runCommand(command)\` — runs the command in the user's interactive shell and returns its combined stdout/stderr and exit code. The user approves (or skips) every call.

# How to operate
- ALWAYS call \`setPlan\` first. Do not narrate the plan in prose — put it in the tool. Then start executing.
- Call \`runCommand\` for ONE logical step at a time so the user can approve granularly. Chain with \`&&\` only when the parts are truly inseparable (e.g. \`cd /var/log && tail -n 50 syslog\`).
- After each result, read the ACTUAL output and decide the next step from it. Don't assume — verify.
- Stop as soon as the goal is met. End with a short summary of findings / what you changed.
- If a command is skipped, adapt — propose an alternative or continue without it.

# Hard rules
- NON-INTERACTIVE ONLY. The command must terminate on its own. Use \`top -bn1\` not \`top\`; \`systemctl --no-pager\`; \`cat\`/\`sed -n\` not \`less\`/\`vim\`/\`man\`. Never run anything that waits for input — it will hang.
- Each command shares the shell state of prior ones is NOT guaranteed (cwd may reset). If you need a directory, include \`cd X && ...\` in the same command.
- Read-only diagnostics FIRST. Before any state-changing or destructive command (\`rm\`, \`kill -9\`, \`systemctl restart\`, package install, config edit, \`dd\`, \`DROP\`…), explain WHY in your text and keep it to that single command so the user can scrutinise it.
- Never exfiltrate secrets. If output contains keys/passwords, note it but don't repeat them.
- Be concise. The user is watching each step; don't narrate the obvious.

Begin by calling setPlan.`;

export async function runAgent(opts: RunAgentOpts): Promise<void> {
  const model = buildLanguageModel(opts.providerId, opts.config);

  const messages: ModelMessage[] = [
    ...trimHistory(opts.history).map(
      (m) => ({ role: m.role, content: m.content }) as ModelMessage,
    ),
    { role: "user", content: opts.goal },
  ];

  const result = streamText({
    model,
    system: `${AGENT_SYSTEM_PROMPT}\n\n${SHELL_GUIDANCE[opts.shell]}`,
    messages,
    abortSignal: opts.signal,
    stopWhen: stepCountIs(opts.maxSteps ?? 12),
    tools: {
      setPlan: tool({
        description:
          "Declare your plan up front as 2–6 short imperative steps. Call this exactly once, before any runCommand.",
        inputSchema: jsonSchema<{ steps: string[] }>({
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: { type: "string" },
              description:
                "2–6 short imperative step descriptions, in order.",
            },
          },
          required: ["steps"],
          additionalProperties: false,
        }),
        execute: async ({ steps }) => {
          const clean = steps
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 8);
          opts.onPlan(clean);
          return { ok: true, accepted: clean.length };
        },
      }),
      runCommand: tool({
        description:
          "Run ONE non-interactive shell command on the connected Linux server and get its stdout/stderr and exit code. The user approves every command.",
        inputSchema: jsonSchema<{ command: string }>({
          type: "object",
          properties: {
            command: {
              type: "string",
              description:
                "A single non-interactive shell command. Chain inseparable steps with &&. Never editors, pagers, or commands that wait for input.",
            },
          },
          required: ["command"],
          additionalProperties: false,
        }),
        execute: async ({ command }) => {
          if (!opts.sessionId) {
            return {
              error:
                "No active terminal session — connect to a server first.",
            };
          }
          const decision = await opts.requestApproval(command);
          if (decision === "abort") {
            throw new Error("aborted by user");
          }
          if (decision === "skip") {
            opts.onStep({
              command,
              output: "",
              exitCode: -1,
              timedOut: false,
              skipped: true,
            });
            return {
              skipped: true,
              note: "User skipped this command. Adapt your approach.",
            };
          }
          const res = await runCapturedCommand(opts.sessionId, command, {
            signal: opts.signal,
            shell: opts.shell,
          });
          const { lines } = redactLines(res.output.split("\n"));
          const safe = lines.join("\n");
          opts.onStep({
            command,
            output: safe,
            exitCode: res.exitCode,
            timedOut: res.timedOut,
            skipped: false,
          });
          return {
            output: safe.slice(0, 8000), // cap tokens
            exitCode: res.exitCode,
            timedOut: res.timedOut,
          };
        },
      }),
    },
  });

  for await (const delta of result.textStream) {
    opts.onText(delta);
  }
}
