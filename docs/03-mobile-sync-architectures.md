# Mobile Sync Architectures

Research date: 2026-03-14

## Approaches in the Ecosystem

Only two open-source projects have shipped mobile sync for agent control.

---

## Happy Engineering: E2E Encrypted Relay Server

### Architecture
```
CLI (local machine) <-> Fastify/Socket.IO relay server <-> Mobile app (React Native/Expo)
                              |
                    PostgreSQL + Redis + S3
```

### Transport
- **Real-time**: WebSocket via Socket.IO (path: `/v1/updates`)
- **CRUD**: HTTP REST (path: `/v1/*`, `/v2/*`)
- **WebSocket transports**: WebSocket primary, HTTP long-polling fallback
- **Reconnection**: Automatic with backoff (1s -> 5s max)

### Encryption
- Server is a **blind relay** — never sees plaintext data
- Two encryption schemes:
  - **Legacy**: NaCl XSalsa20-Poly1305 (tweetnacl secretbox, 32-byte key, 24-byte nonce)
  - **Modern**: AES-256-GCM with per-session data keys, wrapped via libsodium box encryption
- Encrypted payloads: session metadata, agent state, messages, machine metadata, artifacts, KV store values

### WebSocket Client Scopes
- `user-scoped` — mobile app, sees all sessions
- `session-scoped` — CLI session, sees only its own session
- `machine-scoped` — daemon, handles RPC and presence

### State Synchronization
- **Monotonic sequence numbers** per user for consistent ordering
- **Optimistic concurrency**: version-based conditional writes with `expectedVersion` field
- **Persistent updates** (stored in DB): new-session, update-session, new-message, new-machine, etc.
- **Ephemeral events** (not stored): activity, machine-activity, usage, machine-status

### RPC (Mobile -> Desktop)
- Daemon registers RPC handlers via `rpc-register` event
- Mobile calls via `rpc-call` event, server forwards to machine-scoped socket
- Available RPC methods: `spawn-happy-session`, `stop-session`, `stop-daemon`, `bash`, `file-read`, `file-write`, `ripgrep`, `difftastic`

### Daemon Architecture
```
happy CLI
    |
Daemon Process (long-lived)
  |- Local HTTP Control Server (127.0.0.1:random-port)
  |- ApiMachineClient (WebSocket to relay)
  |- RPC Handler Registry
  |- Child Session Processes (1 per session)
```

### Presence
- `session-alive` / `machine-alive` events sent periodically
- Debounced in-memory (ActivityCache), batch-written to DB every 30s
- 10-minute timeout marks sessions/machines offline

### Session Protocol Events
9 event types (discriminated union on `ev.t`):
- `text`, `service`, `tool-call-start`, `tool-call-end`, `file`, `turn-start`, `turn-end`, `start`, `stop`

### Tech Stack
- **CLI**: Node.js, Ink (React TUI), Axios, socket.io-client, tweetnacl
- **Server**: Fastify 5, Socket.IO 4, PostgreSQL (Prisma), Redis, S3/MinIO
- **Mobile**: React Native 0.81, Expo 54, Zustand, MMKV, react-native-libsodium
- **Shared**: `@slopus/happy-wire` npm package with Zod schemas

---

## CodexMonitor: Direct TCP via Tailscale

### Architecture
```
iOS app <-> TCP (Tailscale VPN) <-> Desktop daemon <-> Codex app-server
```

### Protocol
- JSON-RPC over raw TCP (same line-delimited format as app-server)
- Authentication: First message must be `{ method: "auth", params: { token: "..." } }`
- No encryption layer — relies on Tailscale's WireGuard encryption

### Daemon
- Standalone binary: `codex_monitor_daemon`
- Listens on TCP socket (default `127.0.0.1:4732`)
- Control CLI: `codex_monitor_daemonctl` for start/stop/status

### Remote Backend Proxy
- All Tauri commands check `is_remote_mode()` and route to daemon if true
- Retryable methods (read-only): list_threads, list_workspaces, account_*, file_read
- Non-retryable (state-modifying): send_user_message, start_thread

### Limitations
- Requires Tailscale on both devices (same tailnet)
- Desktop must stay running while iOS is connected
- Single iOS client per daemon at a time
- No file uploads from iOS
- No local Codex execution on iOS

### iOS Build
- Tauri 2 iOS targets: aarch64-apple-ios (device), aarch64-apple-ios-sim
- Terminal and dictation are `#[cfg(desktop)]` only
- Defaults to remote backend mode

---

## Comparison

| Aspect | Happy (Relay) | CodexMonitor (Direct) |
|---|---|---|
| Network requirement | Internet (any network) | Same Tailscale tailnet |
| Encryption | E2E (server is blind) | WireGuard (via Tailscale) |
| Infrastructure | Relay server + DB + Redis + S3 | Tailscale only |
| Offline support | Messages queue, sync on reconnect | No (requires live connection) |
| Multi-device | Yes (any number of clients) | Single iOS client per daemon |
| Setup complexity | Higher (server hosting) | Lower (install Tailscale) |
| Remote control | Full RPC (spawn, bash, file ops) | Full (proxied JSON-RPC) |
| Desktop dependency | Daemon must run (but relay buffers) | Daemon must run (no buffering) |
