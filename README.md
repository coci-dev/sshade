<div align="center">

# sshade

**SSH terminal with an AI assistant that actually sees your session.**

No more copy-pasting logs into a chat tab. Connect to your servers, and ask
the AI about what's on screen — it reads the terminal context for you.

`Tauri 2` · `Rust` · `React` · `xterm.js` — Windows · macOS · Linux

</div>

---

## Why

Every sysadmin's debugging loop is the same: SSH in → run a command → see
500 lines of errors → select, copy → alt-tab to ChatGPT → paste → read →
alt-tab back → repeat. sshade collapses that loop. The AI panel lives next
to the terminal and already has the context — you just ask.

## Features

- **Real SSH client** — multi-tab, multi-server, key & password auth,
  `known_hosts` verified (TOFU, rejects on key mismatch)
- **AI that sees the terminal** — last N lines / last-command-only / full
  scrollback, attached automatically; secrets redacted before they leave
  the machine
- **Bring your own key** — Anthropic, OpenAI, Google, DeepSeek, NVIDIA NIM,
  Groq, Ollama (local), or any OpenAI-compatible endpoint. Your key never
  touches a server.
- **Suggested commands are actionable** — `Paste` (edit first) or `Run`
  (execute) any command the AI proposes, straight into the session
- **Organized** — sidebar with collapsible groups, drag-and-drop, saved
  servers (no secrets persisted)
- **Yours to arrange** — dock the AI panel right or bottom, resize every
  pane, dark / light theme — all persisted
- **Lightweight** — Tauri (native WebView, ~15 MB binary, ~60 MB RAM), not
  Electron

## Install

> Pre-built installers ship via GitHub Releases (`.msi` · `.dmg` ·
> `.AppImage` / `.deb`). Until the first tagged release, build from source.

### From source

Prerequisites: [Rust](https://rustup.rs) (stable, MSVC on Windows) and
Node 20+.

```bash
git clone https://github.com/<you>/sshade
cd sshade
npm install
npm run tauri dev      # development
npm run tauri build    # production bundle
```

## Configure the AI

1. **⚙ Settings → AI provider**
2. Pick a provider. Free options to start: **NVIDIA NIM**, **Google
   Gemini** (`gemini-1.5-flash`), **Groq**, or **Ollama** (fully local).
3. Paste your API key → **Test connection** → **Save**.
4. **↻ Refresh from API** populates the model list from your key.

The key is stored locally only and sent solely to the provider you chose.

## Security

- **Host keys:** verified against `~/.ssh/known_hosts`. First connection to
  a new host is trusted and recorded (TOFU, like OpenSSH `accept-new`). A
  changed key **aborts** the connection — possible MITM.
- **Secret redaction:** terminal context is scrubbed for API keys, tokens,
  JWTs, private-key blocks and `SECRET=…` assignments before being sent to
  the AI. Best-effort, not a guarantee — you control how much context goes.
- **Credential storage:** AI API keys are stored in the OS credential
  manager — Windows Credential Manager, macOS Keychain, or Linux Secret
  Service — never in plaintext or `localStorage`. Only non-secret metadata
  (active provider, model, base URL) is persisted locally. Legacy installs
  are migrated automatically on first launch.
- SSH passwords/passphrases are never persisted — re-entered each session.

## Architecture

```
Frontend (React + xterm.js, in the WebView)
  ├─ Terminal — xterm.js, streams bytes over Tauri IPC
  ├─ AI panel — Vercel AI SDK, multi-provider, streaming
  └─ Context capture + secret redaction
        ▲  Tauri IPC (commands + events)
        ▼
Backend (Rust + Tauri 2)
  ├─ russh + tokio — async SSH, one task per session
  └─ known_hosts verification
```

The AI is called from the frontend (your key, your machine). The backend
only does SSH. See [CONTRIBUTING.md](CONTRIBUTING.md) for the IPC contract.

## License

[MIT](LICENSE).
