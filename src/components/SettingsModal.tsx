import { type FormEvent, useEffect, useState } from "react";
import { X } from "lucide-react";
import { fetchModels, testProvider, type TestResult } from "../lib/ai-client";
import {
  type AiSettings,
  type ProviderConfig,
  loadAiSettings,
  saveAiSettings,
} from "../lib/ai-settings";
import { PROVIDER_ORDER, PROVIDERS, type ProviderId } from "../lib/providers";
import { THEMES, THEME_ORDER, type ThemeId } from "../lib/themes";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  themeId: ThemeId;
  onThemeChange: (id: ThemeId) => void;
}

function defaultConfigFor(id: ProviderId): ProviderConfig {
  const meta = PROVIDERS[id];
  return {
    apiKey: "",
    model: meta.defaultModel,
    baseURL: meta.defaultBaseURL,
  };
}

interface TestState {
  loading: boolean;
  result: TestResult | null;
}

interface ModelsState {
  loading: boolean;
  list: string[] | null;
  error: string | null;
}

export function SettingsModal({
  open,
  onClose,
  themeId,
  onThemeChange,
}: SettingsModalProps) {
  const [settings, setSettings] = useState<AiSettings>(() => loadAiSettings());
  // The saved key is never rendered. `keyEditing` swaps the masked display
  // for an empty input; `keyDraft` holds the new key being typed. If the
  // draft stays empty, the previously saved key is kept on save.
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [test, setTest] = useState<TestState>({ loading: false, result: null });
  const [models, setModels] = useState<ModelsState>({
    loading: false,
    list: null,
    error: null,
  });

  useEffect(() => {
    if (open) {
      setSettings(loadAiSettings());
      setKeyEditing(false);
      setKeyDraft("");
      setTest({ loading: false, result: null });
      setModels({ loading: false, list: null, error: null });
    }
  }, [open]);

  if (!open) return null;

  const activeId = settings.active;
  const meta = PROVIDERS[activeId];
  const current = settings.providers[activeId] ?? defaultConfigFor(activeId);

  // Has a key been saved for this provider? (Never shown — only its
  // existence.) `editing` = no saved key yet, or user clicked Edit.
  const hasSavedKey = !!current.apiKey;
  const editing = keyEditing || !hasSavedKey;
  // What Test / Refresh / Save actually use: the freshly typed key if any,
  // otherwise the one already saved. Empty draft ⇒ keep the old key.
  const effectiveKey = keyDraft.trim() ? keyDraft.trim() : current.apiKey;

  function updateCurrent(patch: Partial<ProviderConfig>) {
    setSettings((s) => ({
      ...s,
      providers: {
        ...s.providers,
        [s.active]: { ...current, ...patch },
      },
    }));
    setTest({ loading: false, result: null });
  }

  function selectProvider(id: ProviderId) {
    setSettings((s) => ({
      active: id,
      providers: {
        ...s.providers,
        [id]: s.providers[id] ?? defaultConfigFor(id),
      },
    }));
    setKeyEditing(false);
    setKeyDraft("");
    setTest({ loading: false, result: null });
    setModels({ loading: false, list: null, error: null });
  }

  async function runTest() {
    if (test.loading) return;
    if (meta.needsKey && !effectiveKey.trim()) {
      setTest({
        loading: false,
        result: { ok: false, message: "Enter an API key first." },
      });
      return;
    }
    setTest({ loading: true, result: null });
    const result = await testProvider(activeId, {
      ...current,
      apiKey: effectiveKey,
    });
    setTest({ loading: false, result });
  }

  async function refreshModels() {
    if (models.loading) return;
    if (meta.needsKey && !effectiveKey.trim()) {
      setModels({
        loading: false,
        list: null,
        error: "Enter an API key first.",
      });
      return;
    }
    setModels({ loading: true, list: null, error: null });
    try {
      const list = await fetchModels(activeId, {
        ...current,
        apiKey: effectiveKey,
      });
      if (list.length === 0) {
        setModels({
          loading: false,
          list: [],
          error: "Provider returned no models for this key.",
        });
      } else {
        setModels({ loading: false, list, error: null });
      }
    } catch (e) {
      setModels({
        loading: false,
        list: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const finalSettings: AiSettings = {
      active: settings.active,
      providers: {
        ...settings.providers,
        // effectiveKey = freshly typed key, or the saved one if untouched.
        [settings.active]: { ...current, apiKey: effectiveKey },
      },
    };
    await saveAiSettings(finalSettings);
    onClose();
  }

  // Combine: prefer API-fetched list when available, fall back to hardcoded
  // catalog. If the currently-saved model isn't in the list, surface it as a
  // "(custom)" option so the user's choice survives a refresh.
  const baseList = models.list ?? meta.models;
  const modelOptions = baseList.slice();
  if (current.model && !modelOptions.includes(current.model)) {
    modelOptions.unshift(current.model);
  }
  const useInput = modelOptions.length === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} strokeWidth={1.75} />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="settings-form">
          <section>
            <h3>Appearance</h3>
            <div className="theme-grid">
              {THEME_ORDER.map((id) => {
                const theme = THEMES[id];
                const active = id === themeId;
                return (
                  <button
                    type="button"
                    key={id}
                    className={active ? "theme-card active" : "theme-card"}
                    onClick={() => onThemeChange(id)}
                    title={theme.description}
                  >
                    <div className="theme-swatches">
                      {theme.swatches.map((c, i) => (
                        <span
                          key={i}
                          className="theme-swatch"
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                    <div className="theme-name">{theme.name}</div>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h3>AI provider</h3>

            <label>
              Active provider
              <select
                value={activeId}
                onChange={(e) => selectProvider(e.target.value as ProviderId)}
              >
                {PROVIDER_ORDER.map((id) => {
                  const m = PROVIDERS[id];
                  const configured =
                    !!settings.providers[id]?.apiKey || !m.needsKey;
                  return (
                    <option key={id} value={id}>
                      {m.name}
                      {configured ? "  ✓" : ""}
                    </option>
                  );
                })}
              </select>
            </label>

            {meta.hint && (
              <p className="hint provider-hint">
                {meta.hint}
                {meta.signupUrl && (
                  <>
                    {" "}
                    <a
                      href={meta.signupUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="hint-link"
                    >
                      ↗ {meta.signupUrl.replace(/^https?:\/\//, "")}
                    </a>
                  </>
                )}
              </p>
            )}

            {meta.needsKey && (
              <label>
                API key
                {editing ? (
                  <>
                    <div className="key-row">
                      <input
                        type="password"
                        autoComplete="off"
                        value={keyDraft}
                        autoFocus={keyEditing}
                        onChange={(e) => {
                          setKeyDraft(e.target.value);
                          setTest({ loading: false, result: null });
                        }}
                        placeholder={
                          activeId === "anthropic"
                            ? "sk-ant-..."
                            : activeId === "openai"
                              ? "sk-..."
                              : activeId === "google"
                                ? "AIza..."
                                : "API key"
                        }
                      />
                      {hasSavedKey && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setKeyEditing(false);
                            setKeyDraft("");
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                    {hasSavedKey && (
                      <span className="hint">
                        Leave blank to keep the current key.
                      </span>
                    )}
                  </>
                ) : (
                  <div className="key-row">
                    <span className="key-masked" aria-label="API key saved">
                      •••••••••••••••••••••••• saved
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setKeyEditing(true);
                        setKeyDraft("");
                      }}
                    >
                      Edit
                    </button>
                  </div>
                )}
              </label>
            )}

            {meta.needsBaseURL && (
              <label>
                Base URL
                <input
                  value={current.baseURL ?? ""}
                  onChange={(e) => updateCurrent({ baseURL: e.target.value })}
                  placeholder={meta.defaultBaseURL}
                />
              </label>
            )}

            <label>
              <div className="model-label-row">
                <span>Model</span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={refreshModels}
                  disabled={models.loading}
                >
                  {models.loading ? "Fetching…" : "↻ Refresh from API"}
                </button>
              </div>
              {useInput ? (
                <input
                  value={current.model}
                  onChange={(e) => updateCurrent({ model: e.target.value })}
                  placeholder="model name"
                />
              ) : (
                <select
                  value={current.model}
                  onChange={(e) => updateCurrent({ model: e.target.value })}
                >
                  {modelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
              {models.list && !models.error && (
                <span className="hint">
                  ✓ {models.list.length} model{models.list.length === 1 ? "" : "s"} from API
                </span>
              )}
              {models.error && (
                <span className="test-status bad">⚠ {models.error}</span>
              )}
            </label>

            <div className="test-row">
              <button
                type="button"
                className="secondary"
                onClick={runTest}
                disabled={test.loading}
              >
                {test.loading ? "Testing…" : "Test connection"}
              </button>
              {test.result && (
                <span
                  className={
                    test.result.ok ? "test-status ok" : "test-status bad"
                  }
                  title={test.result.reply}
                >
                  {test.result.ok ? "✓" : "⚠"} {test.result.message}
                </span>
              )}
            </div>
          </section>

          <footer className="modal-footer">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit">Save</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
