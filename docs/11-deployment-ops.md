# Deployment Ops

FalconDeck keeps deployment code in the monorepo under `ops/ansible/`.

## Current Recommendation

For the first public relay deployment, use:

- a small Hetzner VM
- Ubuntu 24.04
- systemd for the relay binary
- Caddy for TLS and reverse proxy

This is intentionally simpler than Docker for the first version. FalconDeck Relay is a single Rust binary, so direct systemd deployment is easier to understand, debug, and maintain in an open-source project.

## Repo Policy

- Commit playbooks, roles, templates, and example inventory
- Do not commit real inventory, IPs, SSH usernames, secrets, or vault passwords
- Keep real host-specific values under gitignored local files

See `ops/ansible/README.md` for the current deployment workflow.

## Future Direction

Docker can still be added later if we want:

- easier container-based self-hosting
- a single image release artifact
- multi-service compose setups

But it should be optional, not the only supported path.
