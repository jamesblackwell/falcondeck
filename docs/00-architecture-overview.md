# FalconDeck — Architecture Overview

Last updated: 2026-03-14

## What it is

Open-source agent control plane for managing multiple coding agents from one interface. Will evolve beyond coding agents toward general task/office agent management.

- **Domain**: falcondeck.com
- **License**: Open source (license TBD)

## Design Philosophy

FalconDeck is built the Unix way. Small, composable pieces that do one thing well.

**The core is a daemon, not a desktop app.** `falcondeck-daemon` is a standalone Rust binary that manages agent processes, translates events, handles permissions, and exposes a unified interface. It runs anywhere — your laptop, a cloud server, a Raspberry Pi. It has no GUI dependency.

**The desktop app is a shell.** Tauri wraps the daemon with a native window. Remove the shell and the daemon still works. The daemon is the product; the GUI is one way to interact with it.

**Everything is a client.** The Tauri desktop, the web UI, the mobile app, a future CLI — they're all clients that connect to the daemon over the same protocol. No client is special.

**Agents are subprocesses, not plugins.** FalconDeck doesn't absorb agent functionality. It spawns `claude` and `codex` as external processes and speaks their native protocols. When agents update, FalconDeck benefits automatically.

**Sessions belong to the agents, not to us.** FalconDeck reads from native session storage and uses native resume mechanisms. No custom conversation database. Users move freely between FalconDeck, the CLI, VS Code, or any other tool.

**The relay is a dumb pipe.** E2E encrypted. The server never sees plaintext. It just forwards bytes between daemon and client. This means the relay can be hosted by anyone without trust implications.

## Deployment Modes

The same Rust daemon binary supports multiple deployment modes:

### Desktop Mode
Tauri shell wraps the daemon. Native window, system tray, OS integration. The daemon runs as a background process managed by the app lifecycle.

### Headless Mode
`falcondeck-daemon` runs standalone on any Linux/macOS machine. No GUI. Serves a web UI over HTTPS. Clients connect directly or via relay.

### Cloud Mode
Daemon runs on a cloud server (Ubuntu, etc.). Always-on — no laptop needed. Repos cloned or mounted on the server. Agents run on server hardware. Access entirely via web/mobile. Path to hosted SaaS product later.

```
Desktop Mode:     [Tauri shell] -> [daemon] -> [agents]
Headless Mode:    [daemon] -> [agents] -> [web UI served directly]
Cloud Mode:       [daemon on server] -> [agents on server] -> [relay or direct HTTPS] -> [any client]
```

All three modes use the same daemon binary. The difference is just what wraps it and where it runs.

## Framework

**Tauri 2 (Rust + Web frontend)** for the desktop shell.

- Binary size: ~10MB (vs ~150MB for Electron)
- Low memory footprint
- Rust backend handles subprocess management natively
- Tauri 2 includes built-in iOS/Android support for future native mobile
- Reference: CodexMonitor validates Tauri 2 + Rust at production scale
- The daemon itself has zero Tauri dependency — it's a plain Rust binary

## Agent Integrations

### Claude Code — CLI Subprocess

- Spawn `claude -p` per turn with structured JSON I/O
- Key flags: `--output-format stream-json`, `--input-format stream-json`, `--include-partial-messages`, `--verbose`
- Permissions: `--permission-prompt-tool` routes approval prompts to FalconDeck's MCP tool
- Session continuity: `--resume <session-id>` or `--session-id <uuid>`
- Auth: user's existing claude.ai login (no API keys)
- Hook system: SessionStart, PreToolUse, PostToolUse, etc.
- Process model: new process per turn, exits when turn completes, resume for next turn
- Reference implementation: Happy Engineering (MIT, `github.com/slopus/happy`)

### Codex — app-server (JSON-RPC over stdio)

- Spawn `codex app-server` as a long-lived subprocess
- Bidirectional JSON-RPC over newline-delimited stdio
- 60+ methods: thread lifecycle, turn management, approvals, models, config, skills, apps, reviews
- Permissions: server-initiated JSON-RPC requests (requestApproval)
- Auth: user's existing OpenAI login
- Process model: long-lived, persistent connection
- Auto-generated types available via `codex app-server generate-ts`
- Protocol designed for backward compatibility
- Reference implementation: CodexMonitor (MIT, `github.com/Dimillian/CodexMonitor`)

## Session Storage

FalconDeck does NOT store conversation data. Agents manage their own sessions natively:

- Claude Code: `~/.claude/projects/<project-hash>/`
- Codex: `$CODEX_HOME/sessions/` (default `~/.codex/sessions/`)

FalconDeck reads from these locations to build the session list and uses the agents' own resume mechanisms. Users can switch between FalconDeck, CLI, VS Code, or any other client — same sessions everywhere.

FalconDeck stores only its own metadata: workspace-to-session mappings, display names, agent type, UI preferences.

## Unified Event Format

Claude Code and Codex produce different event formats. A Rust translation layer normalizes both into a single stream. The UI (local or remote) does not know which agent is running underneath.

Reference: Happy Engineering's session protocol (9 event types: text, service, tool-call-start, tool-call-end, file, turn-start, turn-end, start, stop).

## Worktree Handling

Same-folder by default. Multiple agents can work in the same directory simultaneously. Worktrees available as an optional user choice, never forced. This is a key differentiator vs Conductor (forced worktrees) and others.

## Remote / Mobile Access

Relay server from day one. Not a Phase 2 feature.

```
Desktop daemon <-> Relay server (E2E encrypted) <-> Mobile/web client
```

- Desktop daemon manages agent processes and connects to relay via WebSocket
- Relay is a blind pipe — E2E encrypted, server never sees plaintext
- Mobile/web clients connect to the same relay
- Unified event stream: both agent types look identical to remote clients
- Permissions forwarded to remote client for approval
- Business model: free tier up to a usage limit, paid after
- Reference: Happy Engineering's relay architecture (adopted wholesale, proven reliable)

### Authentication

QR code pairing — no account required.

- Daemon generates a pairing code, mobile client scans it
- Devices exchange encryption keys during pairing
- Relay never stores identity — it just forwards encrypted bytes
- No signup, no email, no OAuth for v1
- Accounts only needed later for cross-device persistence, teams, or billing

### Stateful Relay

The relay is NOT a pure forwarder — it stores encrypted messages and artifact references server-side:

- **Message history**: encrypted messages stored in PostgreSQL, so mobile clients see full conversation history even if daemon is briefly offline
- **Artifacts**: large payloads (diffs, screenshots, files) stored in S3/MinIO, only references sent over WebSocket
- **Reconnection**: monotonic sequence numbers per user — client tracks last received seq, on reconnect says "give me everything after seq N". No duplicates, no gaps.

### Encryption

Adopt Happy's proven scheme:

- NaCl XSalsa20-Poly1305 + AES-256-GCM with per-session data keys
- Data keys wrapped via libsodium box encryption
- Per-session keys limit blast radius of any compromise
- Libraries available for all targets: Rust (sodiumoxide), React Native (react-native-libsodium), web (tweetnacl/libsodium.js)

### Permission Forwarding

- Daemon registers RPC handlers, mobile calls via relay-forwarded RPC
- Permission requests get priority — surface immediately on mobile, bypass normal message ordering
- Requests queue when no client is connected, deliver on reconnect
- Agent-side timeouts are the authority — FalconDeck doesn't impose its own

## Agent Switching

Sessions belong to one agent and cannot be natively transferred (different models, context formats, internal state). However, FalconDeck can offer context handoff: capture the conversation transcript and inject it as context when spawning a new agent in the same folder. Feels continuous to the user.

## Key Differentiators

| vs | FalconDeck advantage |
|---|---|
| CodexMonitor | Multi-agent (not Codex-only) |
| Conductor | Open source, no forced worktrees |
| Harnss | Lean binary (Tauri, not Electron), mobile from day one |
| Happy | Desktop GUI (not CLI-only), multi-agent control panel |
| All | Native session storage (no custom storage that breaks interop) |
