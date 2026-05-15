import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Circle,
  ClipboardPaste,
  Clock,
  Lock,
  Minus,
  PanelBottom,
  PanelRight,
  Play,
  Trash2,
  Unlock,
  Zap,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Archive, Bot, History } from "lucide-react";
import { type AgentApproval, runAgent } from "../lib/agent";
import { isSafeCommand } from "../lib/safe-commands";
import { detectShell } from "../lib/remote-shell";
import { getActiveConfig, hasUsableProvider } from "../lib/ai-settings";
import { MAX_HISTORY_MESSAGES, streamAi, summarizeChat } from "../lib/ai-client";
import { logAudit } from "../lib/audit-store";
import { AuditModal } from "./AuditModal";
import {
  CONTEXT_MODES,
  type ContextMode,
  loadContextMode,
  modeLineLimit,
  modeShortLabel,
  saveContextMode,
} from "../lib/context-mode";
import { PROVIDERS } from "../lib/providers";
import type { TerminalHandle } from "./Terminal";

export interface AgentStepView {
  command: string;
  output: string;
  exitCode: number;
  timedOut: boolean;
  skipped: boolean;
  /** Auto-approved because it classified as a read-only command. */
  auto?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Set on agent step messages — rendered as a collapsible card. */
  step?: AgentStepView;
  /** Set on the agent's plan message — rendered as a live checklist. */
  plan?: { steps: string[]; done: number };
  /** Set on a compacted-history message — rendered as a summary card. */
  summary?: boolean;
}

interface AiPanelProps {
  /** Identifier of the active chat slice (sessionId, or "__no_session__"). */
  chatKey: string;
  /** Null when no terminal is active — context capture falls back to empty. */
  terminalRef: React.RefObject<TerminalHandle | null> | null;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  pending: boolean;
  setPending: React.Dispatch<React.SetStateAction<boolean>>;
  onOpenSettings: () => void;
  /** Current dock position (right or bottom). */
  position: "right" | "bottom";
  /** Toggle between right and bottom dock. */
  onTogglePosition: () => void;
  /** Safety mode — hides Run/Paste so nothing executes by accident. */
  readOnly: boolean;
  onToggleReadOnly: () => void;
  /** SSH session id of the active tab — agent runs commands here. */
  activeSessionId: string | null;
}

const RUNNABLE_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "console",
  "terminal",
  "cmd",
  "bat",
  "batch",
  "powershell",
  "pwsh",
  "ps1",
  "ps",
  "nushell",
  "nu",
]);

/** Coalesce streamed tokens into one state update per frame-ish window.
 *  Without this, every token re-renders the list AND re-parses the whole
 *  growing markdown string (O(n²) CPU + layout thrash on long answers). */
const STREAM_FLUSH_MS = 60;

/** Lines that close the very session the user is working in — almost
 *  never the intent behind a one-click Run (vs. typing it yourself). */
const SESSION_KILLER = /^\s*(exit|logout)\s*$/i;

/**
 * Models often emit an *illustrative* block: comments, blank lines, and
 * several alternative commands ("# or, to see host logs:\nexit\ndocker
 * logs …"). Run executes the block verbatim, so a stray `exit` killed the
 * SSH session. Strip comment/blank lines and drop standalone session
 * killers — what remains is the actual runnable command(s). Paste is
 * untouched (verbatim, user-controlled).
 */
export function sanitizeForRun(block: string): string {
  return block
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (t.startsWith("#")) return false; // shell comment / illustrative
      if (SESSION_KILLER.test(t)) return false; // would close the session
      return true;
    })
    .join("\n");
}

export function AiPanel({
  chatKey,
  terminalRef,
  messages,
  setMessages,
  input,
  setInput,
  pending,
  setPending,
  onOpenSettings,
  position,
  onTogglePosition,
  readOnly,
  onToggleReadOnly,
  activeSessionId,
}: AiPanelProps) {
  const abortMap = useRef<Map<string, AbortController>>(new Map());
  const conversationRef = useRef<HTMLDivElement>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [autoApproveSafe, setAutoApproveSafe] = useState<boolean>(
    () => localStorage.getItem("sshade.agent.autoApproveSafe") === "1",
  );
  // Read inside the agent loop's callbacks without stale-closure risk.
  const autoApproveRef = useRef(autoApproveSafe);
  autoApproveRef.current = autoApproveSafe;
  const [auditOpen, setAuditOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    command: string;
    resolve: (d: AgentApproval) => void;
  } | null>(null);
  const [showContextPreview, setShowContextPreview] = useState(false);
  const [contextMode, setContextMode] = useState<ContextMode>(() =>
    loadContextMode(),
  );

  useEffect(() => {
    saveContextMode(contextMode);
  }, [contextMode]);

  useEffect(() => {
    localStorage.setItem(
      "sshade.agent.autoApproveSafe",
      autoApproveSafe ? "1" : "0",
    );
  }, [autoApproveSafe]);

  const ready = hasUsableProvider();
  const active = getActiveConfig();

  function captureContext(): string[] {
    const t = terminalRef?.current;
    if (!t) return [];
    if (contextMode === "none") return [];
    if (contextMode === "last-command") return t.getLastCommandOutput();
    return t.getLastLines(modeLineLimit(contextMode));
  }

  // captureContext() reads the xterm buffer (getLastLines). Recompute it
  // only when the mode changes, the preview opens, or messages change —
  // NOT on every keystroke (input isn't a dep), which was scanning the
  // whole scrollback per character typed.
  const contextPreview = useMemo(
    () => captureContext(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextMode, showContextPreview, messages],
  );

  // Once the convo exceeds the sliding window, the oldest turns stop
  // being sent — nudge the user to compact (keep context) or clear.
  const realMsgCount = messages.filter(
    (m) => m.content.trim().length > 0,
  ).length;
  const chatIsLong = realMsgCount > MAX_HISTORY_MESSAGES;
  const alreadyCompacted = messages.length === 1 && !!messages[0]?.summary;

  const headerLabel = active
    ? `${PROVIDERS[active.id].name.split(" ")[0]} · ${active.config.model}`
    : "no provider";

  useEffect(() => {
    const el = conversationRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // useCallback so the memoized message components don't re-render just
  // because the parent re-rendered (stable identity).
  const runInTerminal = useCallback(
    (cmd: string) => {
      if (readOnly) return; // safety: never execute in read-only mode
      const safe = sanitizeForRun(cmd);
      if (!safe) return; // block was all comments / `exit` — nothing to run
      terminalRef?.current?.runCommand(safe);
      if (activeSessionId) {
        logAudit({ profileId: chatKey, source: "run", command: safe });
      }
    },
    [readOnly, terminalRef, activeSessionId, chatKey],
  );

  const pasteInTerminal = useCallback(
    (cmd: string) => {
      if (readOnly) return;
      terminalRef?.current?.pasteCommand(cmd);
      if (activeSessionId) {
        logAudit({ profileId: chatKey, source: "paste", command: cmd });
      }
    },
    [readOnly, terminalRef, activeSessionId, chatKey],
  );

  // ── Streamed-token coalescing ──────────────────────────────────────
  const deltaBufRef = useRef("");
  const deltaTimerRef = useRef<number | null>(null);

  const flushDelta = useCallback(() => {
    if (deltaTimerRef.current != null) {
      window.clearTimeout(deltaTimerRef.current);
      deltaTimerRef.current = null;
    }
    const buf = deltaBufRef.current;
    if (!buf) return;
    deltaBufRef.current = "";
    setMessages((m) => {
      const last = m[m.length - 1];
      if (last?.role !== "assistant") return m;
      return [...m.slice(0, -1), { ...last, content: last.content + buf }];
    });
  }, [setMessages]);

  const queueDelta = useCallback(
    (chunk: string) => {
      deltaBufRef.current += chunk;
      if (deltaTimerRef.current == null) {
        deltaTimerRef.current = window.setTimeout(() => {
          deltaTimerRef.current = null;
          flushDelta();
        }, STREAM_FLUSH_MS);
      }
    },
    [flushDelta],
  );

  function clearConversation() {
    if (pending || compacting) return;
    setMessages([]);
  }

  /**
   * Replace the whole conversation with one AI-written factual summary.
   * Lets the user keep continuity past the sliding window instead of
   * silently losing old turns — and shrinks every subsequent request.
   */
  async function compactChat() {
    if (pending || compacting || !active) return;
    const real = messages.filter((m) => m.content.trim().length > 0);
    if (real.length < 2) return;
    setCompacting(true);
    try {
      const summary = await summarizeChat({
        providerId: active.id,
        config: active.config,
        history: real,
      });
      if (summary) {
        setMessages([
          {
            role: "user",
            content: `[Compacted earlier context]\n${summary}`,
            summary: true,
          },
        ]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendAssistant(`⚠ Couldn't compact: ${msg}`);
    } finally {
      setCompacting(false);
    }
  }

  function appendAssistant(content: string) {
    setMessages((m) => [...m, { role: "assistant", content }]);
  }

  async function sendAgent(goal: string) {
    setPending(true);
    const controller = new AbortController();
    abortMap.current.set(chatKey, controller);
    const history = messages;

    setMessages((m) => [
      ...m,
      { role: "user", content: goal },
      { role: "assistant", content: "" },
    ]);

    // Sniff the remote shell from what the terminal has printed so the
    // agent uses the right command vocabulary + exit-code sentinel.
    const shell = detectShell(terminalRef?.current?.getLastLines(200) ?? []);

    try {
      await runAgent({
        providerId: active!.id,
        config: active!.config,
        sessionId: activeSessionId,
        shell,
        history,
        goal,
        signal: controller.signal,
        requestApproval: (command) => {
          // Opt-in shortcut: provably read-only commands skip the gate.
          if (autoApproveRef.current && isSafeCommand(command)) {
            return Promise.resolve<AgentApproval>("run");
          }
          return new Promise((resolve) => {
            setPendingApproval({
              command,
              resolve: (d) => {
                setPendingApproval(null);
                resolve(d);
              },
            });
          });
        },
        onText: queueDelta,
        onPlan: (steps) => {
          if (steps.length === 0) return;
          flushDelta(); // attach buffered reasoning before the plan card
          setMessages((m) => [
            ...m,
            { role: "assistant", content: "", plan: { steps, done: 0 } },
            { role: "assistant", content: "" },
          ]);
        },
        onStep: (step) => {
          logAudit({
            profileId: chatKey,
            source: "agent",
            command: step.command,
            exitCode: step.skipped ? null : step.exitCode,
            outputPreview: step.skipped ? null : step.output,
          });
          flushDelta(); // attach buffered reasoning before the step card
          const auto =
            !step.skipped &&
            autoApproveRef.current &&
            isSafeCommand(step.command);
          setMessages((m) => {
            // Advance the most recent plan checklist by one (1 command ≈
            // 1 plan item — a heuristic, but it tracks progress well).
            const next = m.slice();
            if (!step.skipped) {
              for (let i = next.length - 1; i >= 0; i--) {
                const p = next[i].plan;
                if (p) {
                  next[i] = {
                    ...next[i],
                    plan: {
                      steps: p.steps,
                      done: Math.min(p.done + 1, p.steps.length),
                    },
                  };
                  break;
                }
              }
            }
            return [
              ...next,
              { role: "assistant", content: "", step: { ...step, auto } },
              // Re-open an empty assistant slot for the next reasoning.
              { role: "assistant", content: "" },
            ];
          });
        },
      });
      flushDelta();
    } catch (err) {
      flushDelta();
      const msg = err instanceof Error ? err.message : String(err);
      appendAssistant(`⚠ ${msg}`);
    } finally {
      flushDelta();
      setPendingApproval(null);
      setPending(false);
      abortMap.current.delete(chatKey);
    }
  }

  async function send() {
    if (!input.trim() || pending) return;
    if (!active) {
      onOpenSettings();
      return;
    }

    if (agentMode) {
      const goal = input.trim();
      setInput("");
      await sendAgent(goal);
      return;
    }

    const userText = input.trim();
    const context = captureContext();
    const history = messages;

    setInput("");
    setMessages((m) => [
      ...m,
      { role: "user", content: userText },
      { role: "assistant", content: "" },
    ]);
    setPending(true);

    const controller = new AbortController();
    abortMap.current.set(chatKey, controller);

    try {
      await streamAi({
        providerId: active.id,
        config: active.config,
        history,
        contextLines: context,
        question: userText,
        signal: controller.signal,
        onDelta: queueDelta,
      });
      flushDelta();
    } catch (err) {
      flushDelta(); // land any buffered tokens before the error line
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((m) => {
        const last = m[m.length - 1];
        if (last?.role === "assistant" && last.content === "") {
          return [...m.slice(0, -1), { role: "assistant", content: `⚠ ${msg}` }];
        }
        return [...m, { role: "assistant", content: `⚠ ${msg}` }];
      });
    } finally {
      flushDelta();
      setPending(false);
      abortMap.current.delete(chatKey);
    }
  }

  function stop() {
    // If the agent is waiting on approval, treat Stop as Abort.
    pendingApproval?.resolve("abort");
    abortMap.current.get(chatKey)?.abort();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <aside className="ai-panel">
      <header className="ai-header">
        <span className="ai-title">
          <span className="ai-dot" /> AI Assistant
        </span>
        <div className="ai-header-actions">
          <span className="ai-model" title={active ? active.config.model : ""}>
            {headerLabel}
          </span>
          <button
            className={agentMode ? "icon-btn agent-on" : "icon-btn"}
            onClick={() => !readOnly && setAgentMode((v) => !v)}
            disabled={readOnly || pending}
            title={
              readOnly
                ? "Disable read-only to use the agent"
                : agentMode
                  ? "Agent mode ON — describe a goal, it runs commands step by step (you approve each). Click to turn off."
                  : "Agent mode OFF — turn on to let the AI execute a multi-step task with your approval."
            }
            aria-label="Toggle agent mode"
          >
            <Bot size={15} strokeWidth={1.75} />
          </button>
          <button
            className={readOnly ? "icon-btn readonly-on" : "icon-btn"}
            onClick={onToggleReadOnly}
            title={
              readOnly
                ? "Read-only ON — AI cannot run commands. Click to allow."
                : "Read-only OFF — AI commands can be run. Click to lock."
            }
            aria-label="Toggle read-only mode"
          >
            {readOnly ? (
              <Lock size={15} strokeWidth={1.75} />
            ) : (
              <Unlock size={15} strokeWidth={1.75} />
            )}
          </button>
          <button
            className="icon-btn"
            onClick={onTogglePosition}
            title={`Dock to ${position === "right" ? "bottom" : "right"}`}
            aria-label="Toggle dock position"
          >
            {position === "right" ? (
              <PanelBottom size={15} strokeWidth={1.75} />
            ) : (
              <PanelRight size={15} strokeWidth={1.75} />
            )}
          </button>
          {messages.length > 0 && (
            <button
              className="icon-btn"
              onClick={clearConversation}
              title="Clear conversation"
              aria-label="Clear conversation"
              disabled={pending}
            >
              <Trash2 size={15} strokeWidth={1.75} />
            </button>
          )}
          {activeSessionId && (
            <button
              className="icon-btn"
              onClick={() => setAuditOpen(true)}
              title="Activity log — commands run on this server"
              aria-label="Activity log"
            >
              <History size={15} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </header>

      <div className="ai-context">
        <div className="ai-context-head">
          <span>
            Context <span className="ai-badge">{contextPreview.length}</span>
          </span>
          <div className="ai-context-actions">
            <select
              className="context-mode-select"
              value={contextMode}
              onChange={(e) => setContextMode(e.target.value as ContextMode)}
              title="How much terminal output to send with each question"
            >
              {CONTEXT_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowContextPreview((v) => !v)}
            >
              {showContextPreview ? "Hide" : "Preview"}
            </button>
          </div>
        </div>
        <ul className="ai-context-items">
          <li>
            ✓ Mode: <strong>{modeShortLabel(contextMode)}</strong>
          </li>
          <li className="muted">
            {contextMode === "none"
              ? "no terminal context will be sent"
              : contextPreview.length === 0
                ? "no output yet"
                : `${contextPreview.length} non-empty lines captured`}
          </li>
        </ul>
        {showContextPreview && (
          <pre className="ai-context-preview">
            {contextPreview.length > 0
              ? contextPreview.join("\n")
              : "(nothing captured)"}
          </pre>
        )}
      </div>

      <div className="ai-conversation" ref={conversationRef}>
        {messages.length === 0 && (
          <p className="ai-empty">
            Ask anything about what's in your terminal. Context size is
            adjustable above.
          </p>
        )}
        {messages.map((m, i) => {
          if (m.plan) {
            return <PlanCard key={i} plan={m.plan} />;
          }
          if (m.step) {
            return <StepCard key={i} step={m.step} />;
          }
          if (m.summary) {
            return <SummaryCard key={i} text={m.content} />;
          }
          // Drop empty assistant slots that never got content (agent
          // re-opens one after every step/plan; the trailing one shows
          // the thinking cursor while pending).
          if (
            m.role === "assistant" &&
            !m.content &&
            !(pending && i === messages.length - 1)
          ) {
            return null;
          }
          return (
            <div key={i} className={`ai-msg ai-msg-${m.role}`}>
              {m.role === "assistant" && (
                <div className="ai-msg-author">
                  <span className="ai-dot" /> Assistant
                </div>
              )}
              <div className="ai-msg-body">
                {m.role === "assistant" ? (
                  m.content ? (
                    <AssistantMarkdown
                      content={m.content}
                      onRun={runInTerminal}
                      onPaste={pasteInTerminal}
                      readOnly={readOnly}
                    />
                  ) : (
                    <span className="cursor-blink" aria-label="thinking" />
                  )
                ) : (
                  m.content
                )}
              </div>
            </div>
          );
        })}
      </div>

      {chatIsLong && !alreadyCompacted && !pending && (
        <div className="chat-long-banner">
          {compacting ? (
            <span className="chat-long-text">
              <span className="cursor-blink" aria-label="compacting" />
              Compacting conversation…
            </span>
          ) : (
            <>
              <span className="chat-long-text">
                Long chat — only the last {MAX_HISTORY_MESSAGES} messages
                are sent. Compact to keep older context.
              </span>
              <div className="chat-long-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={clearConversation}
                  title="Delete the whole conversation"
                >
                  <Trash2 size={12} strokeWidth={1.75} />
                  Clear
                </button>
                <button
                  type="button"
                  className="chat-long-compact"
                  onClick={compactChat}
                  title="Summarize the chat with the AI and replace it with that summary"
                >
                  <Archive size={12} strokeWidth={1.75} />
                  Compact
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {pendingApproval && (
        <div className="agent-approval">
          <div className="agent-approval-head">
            <Bot size={13} strokeWidth={1.75} />
            Agent wants to run:
          </div>
          <pre className="agent-approval-cmd">{pendingApproval.command}</pre>
          <div className="agent-approval-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => pendingApproval.resolve("skip")}
            >
              Skip
            </button>
            <button
              type="button"
              className="run-block"
              onClick={() => pendingApproval.resolve("run")}
            >
              <Play size={11} strokeWidth={2} />
              Run
            </button>
          </div>
        </div>
      )}

      <div className="ai-input">
        {!ready && (
          <button className="ai-config-prompt" onClick={onOpenSettings}>
            Configure an AI provider to enable the assistant →
          </button>
        )}
        {agentMode && !pendingApproval && (
          <div className="agent-hint">
            <div className="agent-hint-text">
              <Bot size={12} strokeWidth={1.75} />
              {autoApproveSafe
                ? "Agent mode — read-only commands run automatically; anything that writes still asks."
                : 'Agent mode — describe a goal (e.g. "why is nginx down?"). You approve every command.'}
            </div>
            <button
              type="button"
              className={
                autoApproveSafe
                  ? "agent-auto-toggle on"
                  : "agent-auto-toggle"
              }
              onClick={() => setAutoApproveSafe((v) => !v)}
              title="Auto-approve provably read-only commands (ls, cat, ps…). Mutating commands always ask."
            >
              <Zap size={11} strokeWidth={2} />
              Auto-approve safe
            </button>
          </div>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            agentMode
              ? "Describe a goal for the agent…"
              : "Pregunta…  (Enter to send, Shift+Enter for new line)"
          }
          rows={2}
          disabled={pending}
        />
        <div className="ai-input-actions">
          {pending ? (
            <button className="secondary" onClick={stop}>
              Stop
            </button>
          ) : (
            <button onClick={send} disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
      {auditOpen && (
        <AuditModal
          profileId={chatKey}
          onClose={() => setAuditOpen(false)}
        />
      )}
    </aside>
  );
}

const PlanCard = memo(function PlanCard({
  plan,
}: {
  plan: { steps: string[]; done: number };
}) {
  const allDone = plan.done >= plan.steps.length;
  return (
    <div className="agent-plan">
      <div className="agent-plan-head">
        <Bot size={12} strokeWidth={1.75} />
        Plan
        <span className="agent-plan-count">
          {Math.min(plan.done, plan.steps.length)}/{plan.steps.length}
        </span>
      </div>
      <ol className="agent-plan-list">
        {plan.steps.map((s, idx) => {
          const state =
            idx < plan.done
              ? "done"
              : idx === plan.done && !allDone
                ? "current"
                : "todo";
          return (
            <li key={idx} className={`agent-plan-item ${state}`}>
              <span className="agent-plan-mark">
                {state === "done" ? (
                  <Check size={12} strokeWidth={2.5} />
                ) : state === "current" ? (
                  <span className="cursor-blink" aria-label="in progress" />
                ) : (
                  <Circle size={9} strokeWidth={2} />
                )}
              </span>
              {s}
            </li>
          );
        })}
      </ol>
    </div>
  );
});

const StepCard = memo(function StepCard({ step }: { step: AgentStepView }) {
  const failed = !step.skipped && (step.timedOut || step.exitCode !== 0);
  // Failures matter — open them by default; clean output stays folded.
  const [open, setOpen] = useState(failed);
  const hasBody = !step.skipped;

  const status = step.skipped
    ? { cls: "skipped", icon: <Minus size={12} strokeWidth={2.5} />, label: "skipped" }
    : step.timedOut
      ? { cls: "fail", icon: <Clock size={12} strokeWidth={2} />, label: "timed out" }
      : step.exitCode === 0
        ? { cls: "ok", icon: <Check size={12} strokeWidth={2.5} />, label: "exit 0" }
        : {
            cls: "fail",
            icon: <AlertTriangle size={12} strokeWidth={2} />,
            label: `exit ${step.exitCode}`,
          };

  return (
    <div className={`agent-step agent-step-${status.cls}`}>
      <button
        type="button"
        className="agent-step-head"
        onClick={() => hasBody && setOpen((o) => !o)}
        disabled={!hasBody}
      >
        <span className={`agent-step-stat agent-step-stat-${status.cls}`}>
          {status.icon}
        </span>
        <code className="agent-step-cmd">{step.command}</code>
        {step.auto && (
          <span className="agent-step-auto" title="Auto-approved (read-only)">
            <Zap size={10} strokeWidth={2.5} />
            auto
          </span>
        )}
        <span className="agent-step-label">{status.label}</span>
        {hasBody && (
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={open ? "agent-step-caret open" : "agent-step-caret"}
          />
        )}
      </button>
      {hasBody && open && (
        <pre className="agent-step-output">
          {step.output.slice(0, 8000) || "(no output)"}
        </pre>
      )}
    </div>
  );
});

const SummaryCard = memo(function SummaryCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Drop the "[Compacted earlier context]" marker line for display.
  const body = text.replace(/^\[Compacted earlier context\]\n?/, "");
  return (
    <div className="agent-step agent-step-summary">
      <button
        type="button"
        className="agent-step-head"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="agent-step-stat agent-step-stat-summary">
          <Archive size={12} strokeWidth={2} />
        </span>
        <code className="agent-step-cmd">Compacted earlier context</code>
        <span className="agent-step-label">summary</span>
        <ChevronRight
          size={13}
          strokeWidth={2}
          className={open ? "agent-step-caret open" : "agent-step-caret"}
        />
      </button>
      {open && (
        <div className="agent-step-output agent-step-summary-body">
          <AssistantMarkdown
            content={body}
            onRun={() => {}}
            onPaste={() => {}}
            readOnly
          />
        </div>
      )}
    </div>
  );
});

interface AssistantMarkdownProps {
  content: string;
  onRun: (cmd: string) => void;
  onPaste: (cmd: string) => void;
  /** When true, code blocks show a "read-only" note instead of Run/Paste. */
  readOnly?: boolean;
}

export const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  onRun,
  onPaste,
  readOnly = false,
}: AssistantMarkdownProps) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...rest }) {
            const match = /language-(\w+)/.exec(className || "");
            const text = String(children).replace(/\n$/, "");

            if (!match) {
              return <code {...rest}>{text}</code>;
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            const codeEl = Array.isArray(children) ? children[0] : children;
            const props =
              codeEl && typeof codeEl === "object" && "props" in codeEl
                ? (codeEl as { props: { className?: string; children?: unknown } }).props
                : { className: "", children: "" };
            const match = /language-(\w+)/.exec(props.className || "");
            const lang = match?.[1] ?? "";
            const text = String(props.children ?? "").replace(/\n$/, "");
            const runnable = RUNNABLE_LANGS.has(lang) || lang === "";

            return (
              <div className="md-code-block">
                <div className="md-code-header">
                  <span className="md-code-lang">{lang || "code"}</span>
                  {runnable &&
                    (readOnly ? (
                      <span
                        className="md-readonly"
                        title="Read-only mode — execution disabled"
                      >
                        <Lock size={11} strokeWidth={2} />
                        read-only
                      </span>
                    ) : (
                      <div className="md-code-actions">
                        <button
                          type="button"
                          className="paste-block"
                          onClick={() => onPaste(text)}
                          title="Paste into terminal — does NOT press Enter"
                        >
                          <ClipboardPaste size={12} strokeWidth={1.75} />
                          Paste
                        </button>
                        <button
                          type="button"
                          className="run-block"
                          onClick={() => onRun(text)}
                          title="Paste + Enter — executes immediately"
                        >
                          <Play size={11} strokeWidth={2} />
                          Run
                        </button>
                      </div>
                    ))}
                </div>
                <pre>
                  <code className={props.className}>{text}</code>
                </pre>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
