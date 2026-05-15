import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { streamAi } from "../lib/ai-client";
import { getActiveConfig } from "../lib/ai-settings";
import {
  loadContextMode,
  modeLineLimit,
  modeShortLabel,
} from "../lib/context-mode";
import { PROVIDERS } from "../lib/providers";
import { AssistantMarkdown, type ChatMessage } from "./AiPanel";
import type { TerminalHandle } from "./Terminal";

interface QuickAskProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  /** Close the spotlight and reveal the full AI panel (same conversation). */
  onOpenInPanel: () => void;
  terminalRef: React.RefObject<TerminalHandle | null> | null;
  /** Active session conversation — quick-ask appends to the same thread. */
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** Safety mode — hides Run/Paste on suggested commands. */
  readOnly: boolean;
  /** When set (terminal selection flow), used as context instead of auto-capture. */
  contextOverride?: string[] | null;
}

const QUICK_ACTIONS = [
  "Explain the last error",
  "Suggest the next command",
  "Summarize this output",
  "Is it safe to restart this service?",
];

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Label for the Alt/Option modifier, per OS. */
function altLabel(n: number): string {
  return IS_MAC ? `⌥${n}` : `Alt+${n}`;
}

export function QuickAsk({
  open,
  onClose,
  onOpenSettings,
  onOpenInPanel,
  terminalRef,
  messages,
  setMessages,
  readOnly,
  contextOverride,
}: QuickAskProps) {
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setInput("");
      setAnswer("");
      setError(null);
      setPending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      abortRef.current?.abort();
    }
  }, [open]);

  if (!open) return null;

  const active = getActiveConfig();
  const mode = loadContextMode();

  const hasOverride = !!contextOverride && contextOverride.length > 0;

  function captureContext(): string[] {
    if (hasOverride) return contextOverride as string[];
    const t = terminalRef?.current;
    if (!t || mode === "none") return [];
    if (mode === "last-command") return t.getLastCommandOutput();
    return t.getLastLines(modeLineLimit(mode));
  }

  const ctxCount = captureContext().length;

  async function ask(question: string) {
    const q = question.trim();
    if (!q || pending) return;
    if (!active) {
      onOpenSettings();
      return;
    }

    const context = captureContext();
    const history = messages;
    setInput(""); // clear the field once the question is on its way
    setAnswer("");
    setError(null);
    setPending(true);

    // Persist into the active session's conversation (visible in the panel).
    setMessages((m) => [
      ...m,
      { role: "user", content: q },
      { role: "assistant", content: "" },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamAi({
        providerId: active.id,
        config: active.config,
        history,
        contextLines: context,
        question: q,
        signal: controller.signal,
        onDelta: (chunk) => {
          setAnswer((a) => a + chunk);
          setMessages((m) => {
            const last = m[m.length - 1];
            if (last?.role !== "assistant") return m;
            return [
              ...m.slice(0, -1),
              { ...last, content: last.content + chunk },
            ];
          });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setMessages((m) => {
        const last = m[m.length - 1];
        if (last?.role === "assistant" && last.content === "") {
          return [...m.slice(0, -1), { role: "assistant", content: `⚠ ${msg}` }];
        }
        return m;
      });
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      ask(input);
      return;
    }
    // Alt+1..4 → quick action. Use e.code (layout/modifier independent —
    // e.key is unreliable while Alt is held on some Windows layouts).
    if (e.altKey) {
      const m = /^Digit([1-4])$/.exec(e.code);
      if (m) {
        e.preventDefault();
        const a = QUICK_ACTIONS[Number(m[1]) - 1];
        if (a) {
          setInput(a);
          ask(a);
        }
      }
    }
  }

  const runInTerminal = (cmd: string) => {
    if (readOnly) return;
    terminalRef?.current?.runCommand(cmd);
  };
  const pasteInTerminal = (cmd: string) => {
    if (readOnly) return;
    terminalRef?.current?.pasteCommand(cmd);
  };

  return (
    <div className="quickask-backdrop" onClick={onClose}>
      <div
        className="quickask"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="quickask-head">
          <span className="quickask-kbd">⌘K</span>
          <input
            ref={inputRef}
            className="quickask-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              active
                ? "Ask about your terminal…"
                : "Configure an AI provider first (Settings)"
            }
            disabled={pending}
          />
          {pending && (
            <button
              type="button"
              className="quickask-stop"
              onClick={() => abortRef.current?.abort()}
            >
              Stop
            </button>
          )}
        </div>

        <div className="quickask-ctx">
          {active ? (
            <>
              Context:{" "}
              <strong>
                {hasOverride ? "Selection" : modeShortLabel(mode)}
              </strong>
              {(hasOverride || mode !== "none") && (
                <> · {ctxCount} lines</>
              )}{" "}
              · {PROVIDERS[active.id].name.split(" ")[0]}
            </>
          ) : (
            "No AI provider configured"
          )}
        </div>

        {answer || pending ? (
          <div className="quickask-answer">
            {answer ? (
              <AssistantMarkdown
                content={answer}
                onRun={runInTerminal}
                onPaste={pasteInTerminal}
                readOnly={readOnly}
              />
            ) : (
              <span className="cursor-blink" aria-label="thinking" />
            )}
          </div>
        ) : error ? (
          <div className="quickask-error">⚠ {error}</div>
        ) : (
          <ul className="quickask-actions">
            {QUICK_ACTIONS.map((a, i) => (
              <li key={a}>
                <button
                  type="button"
                  onClick={() => {
                    setInput(a);
                    ask(a);
                  }}
                >
                  <kbd>{altLabel(i + 1)}</kbd>
                  <span>{a}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="quickask-foot">
          <span>
            <kbd>Enter</kbd> ask · <kbd>Esc</kbd> close
          </span>
          {(answer || pending || messages.length > 0) && (
            <button
              type="button"
              className="quickask-open-panel"
              onClick={onOpenInPanel}
            >
              Open in chat
              <ArrowRight size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
