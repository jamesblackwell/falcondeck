# Push delivery for native and custom clients

Encrypted relay access is independent of push. Clients pair as their own trusted
device and use the existing RPC/event protocol. Push is optional routing/display
metadata for a suspended client, not a conversation store or a reliable event log.
On launch or notification tap, recover current state from the daemon.

## Registration and compatibility

`GET /v1/push-capabilities` returns:

```json
{"expo":true,"apns":[{"topic":"org.example.native","environment":"sandbox"}]}
```

Older relays return 404. Continue foreground operation and explain that background
push is unavailable. Do not send raw APNs tokens to the legacy Expo endpoint.

Register with the trusted device's bearer token:

```http
POST /v1/sessions/<session-id>/devices/<device-id>/push-registration
Authorization: Bearer <client-token>
Content-Type: application/json

{"registration":{"provider":"apns","token":"<hex-device-token>","topic":"org.example.native","environment":"sandbox"}}
```

Other accepted registration: `{"registration":{"provider":"expo","token":"<expo-token>"}}`.
`{"registration":null}` disables push for that device. Each device has one active
registration. Registering a replacement removes its previous provider. The daemon
may manage its own session's devices; clients may update only themselves. Revoked
devices cannot register or receive push. Tokens are excluded from device-list APIs.

The released app's `POST .../push-token` with `{"push_token":"..."}` or
`{"push_token":null}` remains supported, with its existing Expo delivery payload
and receipt processing. Each app should pair as a separate device; do not share
credentials or device IDs between installations.

Native registrations persist in a nullable `relay_devices.push_registration`
JSONB column (or the equivalent optional field for file-backed relays). Legacy
`push_token` values remain in their original column. Old binaries ignore the
extra column on rollback. Generation guards protect replacement and removal
against late writes and APNs rejection responses. APNs 410 cleanup also checks
Apple's invalidation timestamp against the registration time; auth/topic errors
never remove a token.

## Foreground and background

New relays advertise `client_activity_supported: true` in their WebSocket Ready
message. Only then may a client send:

```json
{"type":"client-activity","foreground":false}
```

Send `true` when the app becomes active, and replay the current state after each
new Ready. Without this opt-in, a connected client is treated as foreground,
preserving legacy behavior. A device with any foreground socket suppresses its
remote push. Background sockets can retain RPC/audio while receiving OS push;
clients should suppress duplicate local alerts when remote push is registered.
Disconnected devices continue receiving push normally. Only daemons may request
attention delivery; clients cannot send a Notify to trigger broadcasts.

Delivery is best effort, with existing per-session/kind/thread deduplication.
Providers run outside the RPC reader and store lock. APNs has bounded queued and
concurrent work, fixed Apple endpoints, HTTP/2/TLS, cached ES256 authentication,
and bounded retries. It uses separate connection pools per signing identity.
Clients cannot submit a webhook URL or provider private key.

## APNs operator setup

Configure only applications whose Apple signing credentials you control. An
arbitrary third-party app cannot receive direct Apple push through a public relay
until the operator configures its topic, environment and authorized APNs key.
Self-hosted users can configure their own apps without Expo. Additional providers
can extend the tagged registration contract without changing encrypted RPC.

Set `FALCONDECK_RELAY_APNS_CONFIG=/etc/falcondeck/apns.json`. The file contains:

```json
{
  "applications": [
    {
      "topic": "org.example.native",
      "environment": "sandbox",
      "team_id": "TESTTEAM00",
      "key_id": "TESTKEY000",
      "private_key_file": "/etc/falcondeck/apns.p8"
    }
  ]
}
```

Use the Apple APNs P256 PKCS8 `.p8` key, not an App Store Connect API key. Keep
both files outside git, readable only by the relay service account (for example
root:falcondeck, mode 0640, protected parent directory). Configure production as a
separate application entry when needed. The app's signed `aps-environment`
entitlement determines the environment; Debug development builds use sandbox.
The native app must have an explicit push-enabled app ID and provisioning profile.

Absent or invalid APNs configuration disables only native push and is visible in
capability discovery. It does not block relay startup or alter Expo configuration.
After changing keys/topics, restart the relay to recreate connections. Reusing
an existing authorized key does not require revoking Expo's key.

## Payload and privacy

Expo routing data remains under `data` with `sessionId`, `workspaceId`, `threadId`
and `kind`. APNs places the same keys at the payload root alongside `aps.alert`
(`title`, `body`), default sound, and a hashed thread grouping identifier. Native
display text is trimmed as needed to stay within Apple's 4096-byte limit, retaining
complete routing identifiers. Validate the session on tap and fetch that task from
the paired daemon; never use the payload as conversation content or an action.

As with existing Expo notifications, titles, bounded reply previews and routing
metadata are visible to the relay and push provider. Conversation payloads remain
end-to-end encrypted. Notification permission and local per-device enablement
are distinct from shared daemon event preferences.

References: [Apple request format](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
[Apple token connections](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
