# Repo Layout

Last updated: 2026-03-15

FalconDeck is a monorepo.

## Apps

- `apps/desktop` — local desktop shell around the daemon
- `apps/site` — public website
- `apps/remote-web` — paired remote client

## Rust crates

- `crates/falcondeck-core` — shared types and protocol contracts
- `crates/falcondeck-daemon` — local daemon, agent integration, unified event translation
- `crates/falcondeck-relay` — public internet-facing relay server

## Why this shape

- Shared protocol changes stay in one repo.
- Desktop, daemon, relay, and web client can evolve together.
- Open-source contributors can understand the whole system in one place.
- The public site can still be simple and independent without needing a separate repo.

## Deployment model

- Desktop app: user machine
- Daemon: user machine, headless host, or cloud host
- Relay: public cloud server with TLS and persistent storage
- Remote web client: browser app talking to the public relay
- Public site: standard web hosting, can later share infra with the remote web client if useful
