# FalconDeck Remote Web

Browser client for remotely monitoring and controlling FalconDeck sessions through the public relay.

Planned responsibilities:
- paired-device session list
- live timeline and approvals
- reconnect/sync against relay sequence numbers
- mobile-friendly layout

This is distinct from the public marketing site.

## Security boundary

The browser holds a relay bearer token and end-to-end encryption keys while a
tab is paired. They are deliberately tab-scoped in `sessionStorage`; durable
`localStorage` contains only non-secret connection metadata. This limits
accidental disk persistence and cross-tab exposure, but it cannot make secrets
safe from script already executing in the application origin. An XSS in the
remote client must therefore be treated as full control of that paired device.

Production and self-hosted deployments must serve the CSP and other response
headers in `ops/ansible/roles/caddy/templates/Caddyfile.j2`. `index.html` also
contains a CSP fallback for static hosts. Self-hosted relays remain supported
through `https:`/`wss:` connections; pairing-link relay values stay inert until
the user confirms the named host.
