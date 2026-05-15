# Roadmap

Status of sshade. Not a promise — directions, roughly ordered.

## Shipped

- SSH client: multi-tab, multi-server, key + password auth
- `known_hosts` verification (TOFU, reject on mismatch)
- Multi-provider AI (BYOK): Anthropic, OpenAI, Google, DeepSeek, NVIDIA NIM,
  Groq, Ollama, custom OpenAI-compatible
- Streaming responses, abort, timeout, friendly errors
- Context capture: last-N / last-command / full scrollback, configurable
- Secret redaction before context leaves the machine
- Markdown rendering, Paste / Run on suggested commands
- Per-tab conversations
- Sidebar: collapsible groups, drag-and-drop, saved servers
- Connection form: Save-only, recent picker, group assignment
- Layout: dock AI panel right/bottom, resizable panes, persisted
- Themes: dark / light, terminal-native palette
- OS keyring for AI API keys (Credential Manager / Keychain / Secret
  Service), with automatic migration from legacy localStorage
- `Ctrl+K` quick-ask spotlight with contextual suggestions
- Persistent conversations (SQLite, keyed to server profile, deleted with
  the server)

## Next

- [ ] **Windows ConPTY** context capture fix (tracked; needs more data)

## Later / ideas

- SSH config import (`~/.ssh/config`), jump hosts / `ProxyJump`
- SFTP browser pane
- Session recording / audit log (encrypted, local)
- Tool-use: let the AI propose a command and run it with one confirm
- Port forwarding UI
- Plugin/extension surface

## Contributing

Most "Next" and "Later" items are good first issues. See
[CONTRIBUTING.md](CONTRIBUTING.md).
