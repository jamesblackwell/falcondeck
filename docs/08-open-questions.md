# Open Questions

Last updated: 2026-03-14

## Decided

**Mobile/relay auth**: QR code pairing, no account required. Daemon generates a pairing code, client scans it, devices exchange encryption keys. Relay never knows who you are. Accounts and server logins are a later problem — only needed for persistence across devices, teams, or billing. Reference: Happy Engineering.

**Stateful relay**: Relay stores encrypted messages in a database (PostgreSQL) and artifacts in blob storage (S3/MinIO). Mobile clients can view full session history even if the daemon is briefly offline. On reconnect, clients resume from their last known sequence number — no duplicates, no gaps. Reference: Happy Engineering.

**Reconnection & sync**: Monotonic sequence numbers per user. Each client tracks the last sequence it received. On reconnect, requests everything after that sequence. Handles mobile connection drops cleanly. Reference: Happy Engineering.

**E2E encryption scheme**: Adopt Happy's approach — NaCl XSalsa20-Poly1305 (legacy path) + AES-256-GCM with per-session data keys wrapped via libsodium box encryption (modern path). Proven, well-understood, battle-tested in production.

**Unified event format**: Start from Happy's 9 event types (text, service, tool-call-start, tool-call-end, file, turn-start, turn-end, start, stop) as the base. Extend as needed for Codex-specific concepts, but the core contract is proven. Translation happens in the Rust daemon.

**Permission UX over relay**: Follow Happy's RPC pattern — daemon registers RPC handlers, mobile calls via relay-forwarded RPC. Permission requests queue when no client is connected and deliver when a client reconnects. Agent-side timeouts respected (if the agent kills the request before the user responds, that's the agent's decision, not ours).

**Artifact/file handling**: Large payloads (diffs, screenshots, file contents) stored in S3/MinIO, only references sent through the WebSocket. Keeps the real-time stream fast. Reference: Happy Engineering.

## Parked (not blocking v1)

**Multi-user / teams**: One daemon per user, or shared? Matters for cloud/hosted model later. Nothing we decide now fundamentally blocks adding this.

**Agent update resilience**: When agents ship breaking changes to CLI flags or protocols, we'll need version detection and graceful degradation. Can't design for this in advance — handle reactively as breakages happen.

**Codex app-server stability**: No official stability guarantee from OpenAI, but the team is actively promoting it. Treat as stable enough to build on; adapt if it breaks.

**Claude Code app-server**: Will Anthropic ship a structured server protocol? Completely out of our control. CLI subprocess works well today. Monitor and adopt if/when it appears.

## Status

No open questions blocking v1. All major architectural decisions are made. Ready to build.
