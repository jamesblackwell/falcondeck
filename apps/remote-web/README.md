# FalconDeck Remote Web

Browser client for remotely monitoring and controlling FalconDeck sessions through the public relay.

The client provides paired workspace and thread lists, live conversations,
approvals, and reconnect/sync through the daemon and encrypted relay.

This is distinct from the public marketing site and mobile pairing landing page.

## Develop

Run from the repository root:

```sh
npm install
make remote-web-dev
```

The development client runs at `http://localhost:4174`. Pair it with a running
FalconDeck daemon through its relay.

```sh
npm run build --workspace falcondeck-remote-web
npm run typecheck --workspace falcondeck-remote-web
npm run test --workspace falcondeck-remote-web
```

The build writes static assets to `apps/remote-web/dist/`. The default Ansible
Caddy template serves the public site on the pairing host, so a separate browser
client deployment needs its own static hosting configuration.

## Security boundary

The browser holds a relay bearer token and end-to-end encryption keys while a
tab is paired. They are deliberately tab-scoped in `sessionStorage`; durable
`localStorage` contains only non-secret connection metadata. This limits
accidental disk persistence and cross-tab exposure, but it cannot make secrets
safe from script already executing in the application origin. An XSS in the
remote client must therefore be treated as full control of that paired device.

`index.html` contains the browser client's Content Security Policy for static
hosts. A separate production browser deployment should also configure its
response headers; the default Caddy pairing site is not that deployment. Self-hosted relays remain supported
through `https:`/`wss:` connections; pairing-link relay values stay inert until
the user confirms the named host.
