# Architecture Decisions

Research date: 2026-03-14
Last updated: 2026-03-14

Status: Decided. These decisions are based on competitive research and source code analysis of CodexMonitor, Harnss, and Happy Engineering.

## Decision 1: Desktop Framework

**Decision**: Tauri 2 (Rust + Web frontend)

**Options considered**: Tauri 2, Electron, Swift/SwiftUI, Wails, Flutter

**Rationale**:
- Memory efficiency is a top priority
- Tauri binary ~10MB vs Electron ~150MB
- Rust backend handles subprocess management natively (both Claude CLI and Codex app-server)
- Tauri 2 includes iOS/Android support for future native mobile
- CodexMonitor validates this approach at production scale

## Decision 2: Claude Code Integration

**Decision**: CLI subprocess with structured JSON I/O

**Options considered**: Agent SDK (Node.js/Python library), CLI subprocess

**Rationale**:
- The Agent SDK requires API key auth, not claude.ai subscription login. Anthropic's terms prohibit third parties from offering claude.ai login via the SDK.
- CLI subprocess uses the user's existing `claude auth login` session — no API keys, no terms conflicts
- `--output-format stream-json` + `--input-format stream-json` provide structured I/O
- `--permission-prompt-tool` enables interactive approvals via MCP
- `--resume` provides session continuity across turns
- Claude Code's hook system (SessionStart, PreToolUse, PostToolUse) is richer than anything Codex offers
- Happy Engineering (MIT) provides a proven reference implementation
- No Node.js or Python sidecar needed — Rust spawns the CLI directly

## Decision 3: Codex Integration

**Decision**: `codex app-server` (JSON-RPC over stdio)

**Options considered**: app-server, MCP server

**Rationale**:
- OpenAI explicitly recommends app-server for embedded Codex UIs
- 60+ methods covering threads, turns, approvals, models, config, skills, apps, reviews
- Rust speaks JSON-RPC over stdio natively — no sidecar needed
- Auto-generated TypeScript types available via `codex app-server generate-ts` (useful as reference for Rust serde types)
- Protocol designed for backward compatibility
- CodexMonitor (MIT) provides a proven Rust reference implementation
- The MCP path (`codex mcp-server`) has experimental features and version fragmentation issues

## Decision 4: Mobile / Remote Access

**Decision**: E2E encrypted relay server from day one

**Options considered**: Localhost web UI, direct TCP via Tailscale, relay server

**Rationale**:
- Remote access is a core feature, not a Phase 2 bolt-on
- Localhost-only limits usage to same-network access
- Tailscale requires setup on both devices and same tailnet
- Relay server works from anywhere, any device, any network
- Happy Engineering validates this pattern at scale
- Business model: free tier up to a usage limit, paid after
- Reference architecture: Fastify + Socket.IO + PostgreSQL + Redis + S3

## Decision 5: Session Storage

**Decision**: Read from native agent storage locations. Do not create custom session storage.

**Rationale**:
- Claude Code stores sessions at `~/.claude/projects/<project-hash>/`
- Codex stores sessions at `$CODEX_HOME/sessions/` (default `~/.codex/sessions/`)
- FalconDeck uses `--resume` (Claude) and `thread/resume` (Codex) to pick up sessions
- Users can switch between FalconDeck, CLI, VS Code — same sessions everywhere
- FalconDeck stores only its own metadata: workspace mappings, display names, agent type, UI state
- Avoids interop breakage when agents update their storage format

## Decision 6: Worktree Handling

**Decision**: Same-folder by default, worktrees as optional user choice

**Rationale**:
- Both Harnss and CodexMonitor prove multiple agents can work in the same folder
- Conductor's forced-worktree approach creates merge friction in dev environments
- Key differentiator for FalconDeck

## Decision 7: Unified Event Format

**Decision**: Rust translation layer normalizes both agent event formats into a single stream

**Rationale**:
- Claude Code and Codex produce completely different event formats
- The UI (local and remote) should not know which agent is running
- Happy Engineering's session protocol (9 event types) proves this approach works
- Translation happens in the Rust daemon, not in the frontend

## Decision 8: Agent Switching

**Decision**: Context handoff (not native session transfer)

**Rationale**:
- Sessions cannot be natively transferred between agents (different models, context formats, internal state)
- No tool in the ecosystem does true cross-agent session transfer
- FalconDeck can capture the conversation transcript and inject it as context when spawning a new agent
- PolyScope (closed source) likely does the same thing
- This is a UI feature, not an architectural requirement

## Decision 9: Mobile / Relay Authentication

**Decision**: QR code pairing, no account required

**Options considered**: Email/password accounts, OAuth, QR code pairing

**Rationale**:
- Daemon generates a pairing code, client scans it, devices exchange encryption keys
- Relay never knows who you are — no identity stored server-side
- No account creation friction for v1
- Accounts and server logins are a later concern — only needed for persistence across devices, teams, or billing
- Reference: Happy Engineering uses this exact model

## Decision 10: Deployment Modes

**Decision**: One daemon binary, three deployment modes (desktop, headless, cloud)

**Options considered**: Separate binaries per mode, single binary with feature flags

**Rationale**:
- `falcondeck-daemon` is a standalone Rust binary with no GUI dependency
- Desktop mode: Tauri shell wraps the daemon with a native window
- Headless mode: daemon runs standalone on any Linux/macOS machine, serves web UI
- Cloud mode: daemon on a server, always-on, access via relay or direct HTTPS
- Same binary, same codebase — the difference is what wraps it and where it runs
- Unix philosophy: the daemon is the product, the GUI is one client among many

## Decision 11: Stateful Relay with Encrypted Storage

**Decision**: Relay stores encrypted messages and artifacts server-side (Happy's model)

**Options considered**: Stateless relay (pure forwarder), stateful relay with encrypted storage

**Rationale**:
- Mobile clients can view full session history even if daemon is briefly offline
- Monotonic sequence numbers per user enable clean reconnection — client says "give me everything after seq N"
- No duplicates, no gaps on mobile connection drops
- Artifacts (large diffs, screenshots, file contents) stored in S3/MinIO, only references sent over WebSocket
- Happy Engineering proves this works reliably in production
- Tradeoff: requires PostgreSQL + S3 on the relay, but the UX benefit is worth it

## Decision 12: E2E Encryption Scheme

**Decision**: Adopt Happy's encryption — NaCl + AES-256-GCM with per-session data keys

**Options considered**: Custom scheme, Happy's scheme, Signal protocol

**Rationale**:
- NaCl XSalsa20-Poly1305 (legacy path) + AES-256-GCM with per-session data keys wrapped via libsodium box encryption (modern path)
- Battle-tested in production, well-understood cryptographic primitives
- Per-session data keys limit blast radius of any key compromise
- libsodium available for Rust (sodiumoxide / libsodium-sys), React Native, and web

## Decision 13: Unified Event Format

**Decision**: Start from Happy's 9 event types, extend for multi-agent

**Options considered**: Design from scratch, adopt Happy's format, agent-native passthrough

**Rationale**:
- Happy's 9 types (text, service, tool-call-start, tool-call-end, file, turn-start, turn-end, start, stop) cover the core contract
- Extend as needed for Codex-specific concepts (e.g., review, skills)
- Translation happens in the Rust daemon — clients never see raw agent events
- Session ID on every message enables multiplexing multiple agents over one relay connection
- The format is the contract between daemon and every client — proven base reduces risk

## Decision 14: Permission Forwarding over Relay

**Decision**: RPC pattern with queuing, agent-side timeouts respected

**Options considered**: Fail-fast (drop if offline), queue with daemon-side timeout, queue with agent-side timeout

**Rationale**:
- Daemon registers RPC handlers, mobile calls via relay-forwarded RPC (Happy's pattern)
- Permission requests queue when no client is connected, deliver on reconnect
- Agent-side timeouts are the authority — if the agent kills the request before user responds, FalconDeck doesn't override
- No daemon-side artificial timeout needed; agents already have their own
- Priority channel: permission requests bypass normal message ordering so they surface immediately on mobile

## Open Questions

See [08-open-questions.md](08-open-questions.md) for the current list of open questions and their status.
