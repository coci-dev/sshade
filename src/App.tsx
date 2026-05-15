import {
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AiPanel, type ChatMessage } from "./components/AiPanel";
import { ConnectionForm } from "./components/ConnectionForm";
import { EditProfileModal } from "./components/EditProfileModal";
import { SettingsModal } from "./components/SettingsModal";
import { PanelLeft, Settings } from "lucide-react";
import { QuickAsk } from "./components/QuickAsk";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { Terminal, type TerminalHandle } from "./components/Terminal";
import { getActiveConfig, initAiSecrets } from "./lib/ai-settings";
import {
  GENERAL_CHAT_KEY,
  chatDelete,
  chatLoad,
  chatSave,
} from "./lib/chat-store";
import {
  LAYOUT_BOUNDS,
  type LayoutPrefs,
  loadLayout,
  saveLayout,
} from "./lib/layout";
import { PROVIDERS } from "./lib/providers";
import {
  THEMES,
  type ThemeId,
  applyThemeAttribute,
  loadThemeId,
  saveThemeId,
} from "./lib/themes";
import {
  type RecentServer,
  getRecentServers,
  moveServerToGroup,
  removeRecentServer,
  ungroupAllInGroup,
} from "./lib/server-profiles";
import { sshDisconnect } from "./lib/ssh";
import "./App.css";

interface Tab {
  sessionId: string;
  profile: RecentServer;
  initialBytes: number[] | null;
}

interface FormState {
  prefill?: Partial<{
    host: string;
    port: number;
    username: string;
    authMethod: "key" | "password";
    keyPath: string;
    group: string;
  }>;
}

interface ChatState {
  messages: ChatMessage[];
  input: string;
  pending: boolean;
}

const DEFAULT_CHAT: ChatState = { messages: [], input: "", pending: false };

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentServer[]>(() => getRecentServers());
  const [formState, setFormState] = useState<FormState | null>(null);
  const [editProfile, setEditProfile] = useState<RecentServer | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickAskOpen, setQuickAskOpen] = useState(false);
  // When set, QuickAsk uses these lines as context instead of the
  // auto-captured terminal output (terminal text-selection flow).
  const [selectionContext, setSelectionContext] = useState<string[] | null>(
    null,
  );

  // Unified layout prefs (positions, sizes, open states) — all persisted.
  const [layout, setLayout] = useState<LayoutPrefs>(() => loadLayout());

  // Load API keys from the OS keyring into the in-memory cache once at
  // startup (also migrates legacy localStorage keys). The state flip
  // re-renders so AiPanel re-evaluates getActiveConfig() with keys present.
  const [, setSecretsReady] = useState(false);
  useEffect(() => {
    initAiSecrets().finally(() => setSecretsReady(true));
  }, []);

  // Theme: applies CSS via data-theme attribute + drives xterm.js theme.
  const [themeId, setThemeId] = useState<ThemeId>(() => loadThemeId());
  useEffect(() => {
    applyThemeAttribute(themeId);
    saveThemeId(themeId);
  }, [themeId]);
  const xtermTheme = THEMES[themeId].xterm;

  // Debounce localStorage writes so drag doesn't spam.
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveLayout(layout), 200);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [layout]);

  const patchLayout = useCallback((patch: Partial<LayoutPrefs>) => {
    setLayout((prev) => ({ ...prev, ...patch }));
  }, []);

  // Per-session chat state.
  const [chatBySession, setChatBySession] = useState<Map<string, ChatState>>(
    () => new Map(),
  );

  const refsMap = useRef(
    new Map<string, MutableRefObject<TerminalHandle | null>>(),
  );

  function getOrCreateRef(
    sessionId: string,
  ): MutableRefObject<TerminalHandle | null> {
    let r = refsMap.current.get(sessionId);
    if (!r) {
      r = { current: null };
      refsMap.current.set(sessionId, r);
    }
    return r;
  }

  function refreshRecents() {
    setRecents(getRecentServers());
  }

  // ── Active chat (derived) ──────────────────────────────────────────
  // Keyed by SERVER PROFILE (not sessionId) so the conversation survives
  // reconnects and matches what's persisted in the DB.
  const activeProfileId =
    tabs.find((t) => t.sessionId === activeTabId)?.profile.id ?? null;
  const chatKey = activeProfileId ?? GENERAL_CHAT_KEY;
  const activeChat = chatBySession.get(chatKey) ?? DEFAULT_CHAT;

  // Lazy-load the conversation from the DB the first time this key is seen.
  useEffect(() => {
    if (chatBySession.has(chatKey)) return;
    let cancelled = false;
    chatLoad(chatKey)
      .then((json) => {
        if (cancelled || !json) return;
        let msgs: ChatMessage[];
        try {
          msgs = JSON.parse(json) as ChatMessage[];
        } catch {
          return;
        }
        setChatBySession((m) => {
          if (m.has(chatKey)) return m; // user already started typing — keep theirs
          const next = new Map(m);
          next.set(chatKey, { messages: msgs, input: "", pending: false });
          return next;
        });
      })
      .catch((e) => console.error("[sshade] chat load failed", e));
    return () => {
      cancelled = true;
    };
  }, [chatKey, chatBySession]);

  // Debounced persist of the active conversation (streaming resets the
  // timer; it writes ~800ms after the last change).
  const chatSaveTimer = useRef<number | null>(null);
  useEffect(() => {
    const chat = chatBySession.get(chatKey);
    if (!chat) return;
    if (chatSaveTimer.current) window.clearTimeout(chatSaveTimer.current);
    chatSaveTimer.current = window.setTimeout(() => {
      chatSave(chatKey, JSON.stringify(chat.messages)).catch((e) =>
        console.error("[sshade] chat save failed", e),
      );
    }, 800);
    return () => {
      if (chatSaveTimer.current) window.clearTimeout(chatSaveTimer.current);
    };
  }, [chatBySession, chatKey]);

  const setMessages = useCallback<Dispatch<SetStateAction<ChatMessage[]>>>(
    (update) => {
      setChatBySession((map) => {
        const next = new Map(map);
        const prev = next.get(chatKey) ?? DEFAULT_CHAT;
        const newMessages =
          typeof update === "function" ? update(prev.messages) : update;
        next.set(chatKey, { ...prev, messages: newMessages });
        return next;
      });
    },
    [chatKey],
  );

  const setInput = useCallback<Dispatch<SetStateAction<string>>>(
    (update) => {
      setChatBySession((map) => {
        const next = new Map(map);
        const prev = next.get(chatKey) ?? DEFAULT_CHAT;
        const newInput =
          typeof update === "function" ? update(prev.input) : update;
        next.set(chatKey, { ...prev, input: newInput });
        return next;
      });
    },
    [chatKey],
  );

  const setPending = useCallback<Dispatch<SetStateAction<boolean>>>(
    (update) => {
      setChatBySession((map) => {
        const next = new Map(map);
        const prev = next.get(chatKey) ?? DEFAULT_CHAT;
        const newPending =
          typeof update === "function" ? update(prev.pending) : update;
        next.set(chatKey, { ...prev, pending: newPending });
        return next;
      });
    },
    [chatKey],
  );

  // ── Tab lifecycle ──────────────────────────────────────────────────
  function addTab(
    sessionId: string,
    profile: RecentServer,
    initialBytes: number[] | null,
  ) {
    setTabs((t) => [...t, { sessionId, profile, initialBytes }]);
    setActiveTabId(sessionId);
  }

  // Note: closing a tab does NOT drop the conversation — it's keyed by
  // server profile and persists (in memory + DB) across reconnects. Only
  // deleting the saved server (onRemoveRecent) erases its chat.

  const closeTab = useCallback(
    async (sessionId: string) => {
      try {
        await sshDisconnect(sessionId);
      } catch (e) {
        console.error("[sshade] disconnect error", e);
      }
      setTabs((t) => {
        const next = t.filter((tab) => tab.sessionId !== sessionId);
        if (sessionId === activeTabId) {
          if (next.length > 0) {
            const idx = t.findIndex((tab) => tab.sessionId === sessionId);
            const newActive = next[Math.min(idx, next.length - 1)] ?? next[0];
            setActiveTabId(newActive.sessionId);
          } else {
            setActiveTabId(null);
          }
        }
        return next;
      });
      refsMap.current.delete(sessionId);
    },
    [activeTabId],
  );

  const handleTabClosed = useCallback(
    (sessionId: string, _reason: string) => {
      setTabs((t) => t.filter((tab) => tab.sessionId !== sessionId));
      refsMap.current.delete(sessionId);
      setActiveTabId((current) => {
        if (current !== sessionId) return current;
        const remaining = tabs.filter((tab) => tab.sessionId !== sessionId);
        return remaining[0]?.sessionId ?? null;
      });
    },
    [tabs],
  );

  function openNewServerForm() {
    setFormState({ prefill: undefined });
  }

  function openReconnectForm(server: RecentServer) {
    const existing = tabs.find((t) => t.profile.id === server.id);
    if (existing) {
      setActiveTabId(existing.sessionId);
      return;
    }
    setFormState({
      prefill: {
        host: server.host,
        port: server.port,
        username: server.username,
        authMethod: server.authMethod,
        keyPath: server.keyPath,
      },
    });
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuickAskOpen((v) => !v);
      } else if (e.key === "F1") {
        e.preventDefault();
        patchLayout({ sidebarOpen: !layout.sidebarOpen });
      } else if (e.key === "F2") {
        e.preventDefault();
        patchLayout({ aiOpen: !layout.aiOpen });
      } else if (e.key === "Escape") {
        // Close any open modal — multiple Esc presses no longer required.
        if (quickAskOpen) setQuickAskOpen(false);
        if (formState) setFormState(null);
        if (editProfile) setEditProfile(null);
        if (settingsOpen) setSettingsOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    formState,
    editProfile,
    settingsOpen,
    quickAskOpen,
    layout.sidebarOpen,
    layout.aiOpen,
    patchLayout,
  ]);

  // ── Resize splitters ───────────────────────────────────────────────
  function startResize(
    e: React.MouseEvent,
    axis: "x" | "y",
    direction: "left" | "right" | "top",
    startValue: number,
    bounds: { min: number; max: number },
    apply: (v: number) => void,
  ) {
    e.preventDefault();
    const startCoord = axis === "x" ? e.clientX : e.clientY;
    function onMove(ev: MouseEvent) {
      const cur = axis === "x" ? ev.clientX : ev.clientY;
      const delta = cur - startCoord;
      let v: number;
      if (direction === "left") v = startValue + delta;
      else if (direction === "right") v = startValue - delta;
      else v = startValue - delta; // "top" — when dragging top edge of bottom panel
      apply(clamp(v, bounds.min, bounds.max));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  function startSidebarResize(e: React.MouseEvent) {
    startResize(
      e,
      "x",
      "left",
      layout.sidebarWidth,
      LAYOUT_BOUNDS.sidebar,
      (v) => patchLayout({ sidebarWidth: v }),
    );
  }

  function startAiResize(e: React.MouseEvent) {
    if (layout.aiPosition === "right") {
      startResize(e, "x", "right", layout.aiWidth, LAYOUT_BOUNDS.aiWidth, (v) =>
        patchLayout({ aiWidth: v }),
      );
    } else {
      startResize(e, "y", "top", layout.aiHeight, LAYOUT_BOUNDS.aiHeight, (v) =>
        patchLayout({ aiHeight: v }),
      );
    }
  }

  function toggleAiPosition() {
    patchLayout({
      aiPosition: layout.aiPosition === "right" ? "bottom" : "right",
    });
  }

  // ── Derived ────────────────────────────────────────────────────────
  const activeTab = useMemo(
    () => tabs.find((t) => t.sessionId === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const activeTerminalRef = activeTab
    ? getOrCreateRef(activeTab.sessionId)
    : null;

  const aiActive = getActiveConfig();
  const aiProviderName = aiActive
    ? PROVIDERS[aiActive.id].name.split(" ")[0]
    : null;
  const aiModelName = aiActive?.config.model ?? null;
  const hostLabel = activeTab
    ? `${activeTab.profile.username}@${activeTab.profile.host}`
    : null;

  const openProfileIds = useMemo(
    () => new Set(tabs.map((t) => t.profile.id)),
    [tabs],
  );

  const tabBarTabs = tabs.map((t) => ({
    id: t.sessionId,
    label: t.profile.label || t.profile.host,
    status: "connected" as const,
    pending: chatBySession.get(t.sessionId)?.pending ?? false,
  }));

  const appClasses = [
    "app",
    layout.aiOpen ? "ai-open" : "ai-closed",
    layout.sidebarOpen ? "sidebar-open" : "sidebar-closed",
    `ai-${layout.aiPosition}`,
  ].join(" ");

  const appStyle: CSSProperties = {
    "--sidebar-w": `${layout.sidebarWidth}px`,
    "--aipanel-w": `${layout.aiWidth}px`,
    "--aipanel-h": `${layout.aiHeight}px`,
  } as CSSProperties;

  return (
    <main className={appClasses} style={appStyle}>
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="icon-btn burger-btn"
            onClick={() => patchLayout({ sidebarOpen: !layout.sidebarOpen })}
            title="Toggle servers (F1)"
            aria-label="Toggle servers sidebar"
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
          <span className="brand">sshade</span>
        </div>
        <div className="topbar-actions">
          <button
            className="ghost-btn"
            onClick={() => patchLayout({ aiOpen: !layout.aiOpen })}
            title="Toggle AI panel (F2)"
          >
            {layout.aiOpen ? "Hide AI" : "Show AI"}
          </button>
          <button
            className="icon-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            <Settings size={16} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <Sidebar
        recents={recents}
        openProfileIds={openProfileIds}
        activeProfileId={activeTab?.profile.id ?? null}
        onSelectRecent={openReconnectForm}
        onNewServer={openNewServerForm}
        onRemoveRecent={async (id) => {
          const openOnes = tabs.filter((t) => t.profile.id === id);
          await Promise.all(openOnes.map((t) => closeTab(t.sessionId)));
          removeRecentServer(id);
          // Erase its conversation too (DB + memory) — id IS the chat key.
          chatDelete(id).catch((e) =>
            console.error("[sshade] chat delete failed", e),
          );
          setChatBySession((m) => {
            if (!m.has(id)) return m;
            const next = new Map(m);
            next.delete(id);
            return next;
          });
          refreshRecents();
        }}
        onEditProfile={(s) => setEditProfile(s)}
        onMoveToGroup={(id, group) => {
          moveServerToGroup(id, group);
          refreshRecents();
        }}
        onDeleteGroup={(groupName) => {
          ungroupAllInGroup(groupName);
          refreshRecents();
        }}
      />

      <div className="main-area">
        <TabBar
          tabs={tabBarTabs}
          activeId={activeTabId}
          onSelect={(id) => setActiveTabId(id)}
          onClose={(id) => closeTab(id)}
          onNew={openNewServerForm}
        />

        <div className="content">
          {tabs.length === 0 ? (
            <div className="content-centered">
              <div className="empty-state">
                <p className="empty-title">sshade</p>
                <p className="empty-sub">
                  SSH terminal with AI assistant. Connect to a server to begin.
                </p>
                <button className="primary" onClick={openNewServerForm}>
                  + New server
                </button>
              </div>
            </div>
          ) : (
            tabs.map((tab) => (
              <div
                key={tab.sessionId}
                className={
                  tab.sessionId === activeTabId
                    ? "terminal-slot active"
                    : "terminal-slot"
                }
              >
                <Terminal
                  ref={getOrCreateRef(tab.sessionId)}
                  sessionId={tab.sessionId}
                  initialBytes={tab.initialBytes}
                  xtermTheme={xtermTheme}
                  onClosed={(reason) => handleTabClosed(tab.sessionId, reason)}
                  onAskSelection={(lines) => {
                    setSelectionContext(lines);
                    setQuickAskOpen(true);
                  }}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <AiPanel
        chatKey={chatKey}
        terminalRef={activeTerminalRef}
        messages={activeChat.messages}
        setMessages={setMessages}
        input={activeChat.input}
        setInput={setInput}
        pending={activeChat.pending}
        setPending={setPending}
        onOpenSettings={() => setSettingsOpen(true)}
        position={layout.aiPosition}
        onTogglePosition={toggleAiPosition}
        readOnly={layout.readOnly}
        onToggleReadOnly={() => patchLayout({ readOnly: !layout.readOnly })}
        activeSessionId={activeTabId}
      />

      {/* Resize splitters — absolutely positioned drag handles */}
      {layout.sidebarOpen && (
        <div
          className="splitter splitter-sidebar"
          onMouseDown={startSidebarResize}
          title="Drag to resize"
        />
      )}
      {layout.aiOpen && layout.aiPosition === "right" && (
        <div
          className="splitter splitter-ai-right"
          onMouseDown={startAiResize}
          title="Drag to resize"
        />
      )}
      {layout.aiOpen && layout.aiPosition === "bottom" && (
        <div
          className="splitter splitter-ai-bottom"
          onMouseDown={startAiResize}
          title="Drag to resize"
        />
      )}

      <StatusBar
        connected={!!activeTab}
        host={hostLabel}
        aiProvider={aiProviderName}
        aiModel={aiModelName}
        readOnly={layout.readOnly}
      />

      <QuickAsk
        open={quickAskOpen}
        onClose={() => {
          setQuickAskOpen(false);
          setSelectionContext(null);
        }}
        onOpenSettings={() => {
          setQuickAskOpen(false);
          setSettingsOpen(true);
        }}
        onOpenInPanel={() => {
          setQuickAskOpen(false);
          setSelectionContext(null);
          if (!layout.aiOpen) patchLayout({ aiOpen: true });
        }}
        terminalRef={activeTerminalRef}
        messages={activeChat.messages}
        setMessages={setMessages}
        readOnly={layout.readOnly}
        contextOverride={selectionContext}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        themeId={themeId}
        onThemeChange={setThemeId}
      />

      <EditProfileModal
        server={editProfile}
        onClose={() => setEditProfile(null)}
        onSaved={() => refreshRecents()}
      />

      {formState && (
        <div className="modal-backdrop" onClick={() => setFormState(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <ConnectionForm
              prefill={formState.prefill}
              onCancel={() => setFormState(null)}
              onConnected={(result, profile) => {
                addTab(result.session_id, profile, result.initial);
                setFormState(null);
                refreshRecents();
              }}
              onSaved={() => {
                setFormState(null);
                refreshRecents();
              }}
            />
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
