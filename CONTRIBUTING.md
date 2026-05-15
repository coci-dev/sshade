# Contributing to sshade

Thanks for considering a contribution.

## Dev setup

Prerequisites: [Rust](https://rustup.rs) stable (MSVC toolchain on
Windows), Node 20+.

```bash
npm install
npm run tauri dev
```

First run compiles the Rust backend (a few minutes); later runs are
incremental.

### Checks before opening a PR

```bash
npx tsc --noEmit                       # frontend types
cd src-tauri && cargo check && cargo clippy   # backend
```

Keep both clean. CI runs these on every push.

## Project layout

```
src/                         frontend (React + TypeScript)
  components/                Terminal, AiPanel, Sidebar, modals…
  lib/                       ssh.ts, ai-client.ts, themes, redact, layout…
src-tauri/src/
  lib.rs                     Tauri commands + state
  ssh.rs                     russh client, per-session task, known_hosts
.interface-design/system.md  the design system — READ before UI changes
```

## Design

UI changes must follow `.interface-design/system.md`: the terminal-native
palette (no purple SaaS accent), the cursor-block signature, hairline
borders, the surface elevation ramp. Run the squint test before submitting.

## IPC contract

Backend → frontend events: `ssh:data` `{ session_id, data: number[] }`,
`ssh:closed` `{ session_id, reason }`.

Frontend → backend commands: `ssh_connect(config) -> { session_id,
initial }`, `ssh_send_input(sessionId, data)`, `ssh_resize(sessionId,
cols, rows)`, `ssh_disconnect(sessionId)`.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`).
- No new dependency without a reason in the PR description.
- Don't `replace_all` hex in `src/App.css` — it mangles the token
  definitions. Edit `:root` theme blocks by hand.
- Security-touching changes (auth, known_hosts, redaction) get extra
  scrutiny; explain the threat model in the PR.

## Reporting

Bugs/ideas → GitHub Issues. For security issues, do not open a public
issue — contact the maintainers privately first.
