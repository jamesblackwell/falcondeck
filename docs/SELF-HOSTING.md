# Self-hosting the FalconDeck relay

FalconDeck ships pointed at the hosted relay, `https://connect.falcondeck.com`.
Every client (desktop, iOS, remote web) and every enrolled server daemon can
instead use a relay you run yourself — the relay is a single Rust binary with
no external dependencies, and because every payload is end-to-end encrypted
between your devices, the relay operator (you, or us) can never read message
content either way. Self-hosting is about custody and availability, not an
extra security tier.

## What the relay does

- Brokers pairing between daemons and devices (challenge-signed claims).
- Stores an encrypted, sequence-numbered update log per session so clients
  can disconnect and replay what they missed.
- Forwards encrypted RPC calls from clients to the owning daemon.
- Sends push notifications for attention events through Expo Push Service
  (optional; see the configuration below).
- Serves `/dist/` — prebuilt daemon binaries used by the desktop app's
  one-click server provisioning.

It never sees plaintext: updates, RPC params, and results are sealed with a
per-session data key exchanged between your devices via NaCl box; the relay
stores and forwards ciphertext.

## Running it

Build and run (any Linux/macOS box with Rust):

```sh
cargo build --release -p falcondeck-relay
FALCONDECK_RELAY_STATE_DIR=/var/lib/falcondeck-relay \
  ./target/release/falcondeck-relay --port 8787
```

Put TLS in front of it (Caddy, nginx, or a cloud load balancer) — clients
require `https://` in production. WebSockets must be forwarded
(`/v1/updates/ws`).

The repo's own deployment is a working reference: `deploy.sh` +
`ansible/` provision the hosted relay (systemd unit, nginx TLS termination,
`/dist/` binary hosting) on a stock Ubuntu server.

## Pointing FalconDeck at your relay

- **Desktop → Settings → Servers → Add server → Advanced**: set the relay
  URL before connecting a server. The URL is stored per server, so different
  servers can use different relays.
- **Desktop → Settings → Remote Access**: the relay used for pairing your
  phone/browser to this Mac comes from `VITE_FALCONDECK_RELAY_URL` at build
  time (defaults to the hosted relay); set it when building your own desktop
  bundle.
- **Server daemons**: the relay URL is a parameter of the pairing call —
  `POST /api/remote/pairing {"relay_url": "https://relay.example.com"}`. The
  desktop provisioning flow passes your configured URL automatically.
- **Remote web**: append `?relay=https://relay.example.com` to the app URL,
  or set `VITE_FALCONDECK_RELAY_URL` when building `apps/remote-web`.

## Hosting provisioning binaries

The desktop "Add server" flow downloads
`{relay_url}/dist/falcondeck-daemon-{arch}-linux` onto the target host. To
support that on a self-hosted relay, build the daemon for your server
architectures and serve the files from `/dist/` (see the ansible role for
the hosted layout, including `.sha256` checksums). If `/dist/` is absent,
provisioning falls back with a clear error and you can install the daemon
manually:

```sh
cargo build --release -p falcondeck-daemon   # on the server, or cross-compile
install -m755 target/release/falcondeck-daemon ~/.local/bin/
```

Then create the systemd user unit (the provisioning flow writes exactly
this) with `FALCONDECK_STATE_PATH` and `FALCONDECK_SECRET_FILE` set under
`~/.falcondeck/`, start it, and pair with a code as above.

## Notes

- The relay keeps per-session state under its state dir; back it up if you
  care about replay continuity (losing it forces devices to re-sync from a
  fresh snapshot, not re-pair).
- Multiple FalconDeck installs can share one relay; sessions are isolated by
  pairing-derived keys.
- Push delivery is disabled by setting `FALCONDECK_RELAY_EXPO_PUSH_URL` to an
  empty value. By default the relay sends through Expo, which handles the
  APNs/FCM provider credentials associated with the mobile app. Set
  `FALCONDECK_RELAY_EXPO_ACCESS_TOKEN` if the Expo project requires
  authenticated Push API requests. Receipt polling can be pointed at a test
  endpoint with `FALCONDECK_RELAY_EXPO_RECEIPTS_URL`.
- The mobile app must be installed as a physical development, ad-hoc, or
  TestFlight build with the `expo-notifications` native configuration. Expo Go
  and simulators are not a valid end-to-end push test. See
  `docs/NOTIFICATIONS.md` for the release checklist.
