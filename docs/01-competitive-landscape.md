# Competitive Landscape

Research date: 2026-03-14

## Open-Source Agent Control UIs

### CodexMonitor
- **Author**: Dimillian (Thomas Ricouard)
- **Repo**: github.com/Dimillian/CodexMonitor
- **Framework**: Tauri 2.10 + Rust + React 19
- **Agent support**: Codex only
- **Agent interface**: Spawns `codex app-server` subprocess, JSON-RPC over stdio
- **Mobile**: iOS via remote daemon over TCP/Tailscale (desktop must stay running)
- **Session management**: One Codex session per workspace, multiple threads per session
- **Worktrees**: Supported but optional (separate WorkspaceEntry with parent_id)
- **State management**: useReducer + context (40+ composed hooks)
- **Key features**: Diff viewer (@pierre/diffs in Web Worker), approval prompt overlays, terminal dock, Whisper dictation, multi-workspace support
- **Remote mode**: Standalone daemon binary (`codex_monitor_daemon`), TCP + JSON-RPC, Tailscale for NAT traversal

### Harnss
- **Repo**: github.com/OpenSource03/harnss
- **Framework**: Electron 40 + React 19
- **Agent support**: Claude Code (via SDK), Codex (via app-server subprocess), ACP agents (via subprocess)
- **Agent interface**: Hybrid — Claude Code runs as in-process SDK, Codex as subprocess (JSON-RPC), ACP as subprocess
- **Mobile**: None
- **Session management**: Engine locked per session, switching agents requires new chat
- **Worktrees**: Optional, user-controlled. Agents work in same folder by default
- **State management**: useReducer + 20+ shared refs for closure stability
- **Key features**: Multi-agent support, interactive tool call cards with word-level diffs, MCP integration with OAuth, 3-mode permission system (ask/accept-edits/allow-all), Monaco editor embedded
- **Performance**: GPU acceleration flags, V8 cache bypass, streaming buffer with rAF batching

### Happy Engineering
- **Repo**: github.com/slopus/happy
- **Framework**: CLI (Node.js/Ink) + Fastify relay server + React Native/Expo (iOS, Android, Web)
- **Agent support**: Claude Code, Codex, Gemini
- **Agent interface**: CLI wraps agent processes; Claude via SDK + CLI subprocess, Codex via MCP client
- **Mobile**: Best-in-class — iOS + Android + Web via E2E encrypted relay server
- **Session management**: Sessions stored on relay server (encrypted), monotonic sequence numbers for ordering
- **State management**: Zustand (mobile), React hooks (CLI)
- **Key features**: E2E encryption (server is blind relay), RPC over WebSocket for remote control, offline-first with reconnection, daemon mode for headless operation

### Conductor
- **Website**: conductor.build (closed source)
- **Agent support**: Claude Code, Codex
- **Worktrees**: Forced — "each Conductor workspace is a new git worktree"
- **Mobile**: None mentioned
- **Framework**: Likely Swift/native macOS (macOS only)
- **Key features**: Checkpoints, diff viewer, todos, parallel agents, slash commands, MCP support

## Feature Matrix

| Feature | CodexMonitor | Harnss | Happy | Conductor |
|---|---|---|---|---|
| Open source | Yes (MIT) | Yes | Yes (MIT) | No |
| Multi-agent | No (Codex only) | Yes (Claude, Codex, ACP) | Yes (Claude, Codex, Gemini) | Yes (Claude, Codex) |
| Desktop framework | Tauri 2 (Rust) | Electron | N/A (CLI) | Native macOS |
| Mobile | iOS (remote daemon) | No | iOS, Android, Web | No |
| Same-folder agents | Yes | Yes | Yes | No (forced worktrees) |
| MCP support | Via Codex | Yes (with OAuth) | Yes | Yes |
| Code review | @pierre/diffs | Word-level diffs | Via relay | Diff viewer |
| Offline support | Local-first | Local-first | Yes (hot reconnect) | Local-first |
