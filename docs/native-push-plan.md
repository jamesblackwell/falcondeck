# Provider-neutral push alongside Expo

The relay already supports independent trusted clients and encrypted RPC. Swift
does not need a separate conversation or relay protocol. The remaining platform
gap is delivery while iOS suspends the app.

1. Add a provider-tagged push registration endpoint and capability discovery.
   Keep the existing Expo endpoint, body, tokens, receipts and payload unchanged.
   Authentication still limits a client to its own trusted device.
2. Add optional APNs delivery through operator-configured topic/environment
   allowlists and private signing keys. Clients cannot supply arbitrary URLs or
   credentials. No configuration means no native provider; it must not prevent
   relay startup or affect Expo.
3. Store native registrations in a nullable JSONB column, preserving legacy
   Expo tokens. Maintain generation guards and clear only the failed registration,
   so delayed rejection responses cannot remove a replacement token. A rollback
   to the old binary ignores the extra column and keeps Expo working.
4. Implement native permission/token registration, notification-tap navigation,
   disabled/unsupported/error states, foreground suppression and unregistering.
   Request fresh APNs tokens from iOS and reconcile on reconnect/foreground.
5. Exercise mixed Expo/APNs delivery, malformed/unauthorized registration,
   disabled-provider isolation, persistence/restart and rejected-token races.
   Run native regressions and repo autoreview before deployment.
6. Deploy only the relay binary/config after a private backup and migration
   check, with health/reconnect checks and an immediate old-binary rollback.
   Avoid the full web/mobile deployment playbook. Rebuild/install only the native
   Debug app; no published app build, OTA or TestFlight.

Third-party clients can use Expo or a configured APNs application; additional
providers can extend the tagged contract. APNs requires the app owner's Apple
credentials and an entitled bundle ID. A public relay cannot send to an arbitrary
third-party bundle without that application's operator configuration. Self-hosted
operators can configure their own apps; foreground encrypted access needs no
push credentials. Never expose APNs private keys to clients or in git.

Display metadata has the existing privacy boundary: title/reply preview and
routing identifiers are visible to the relay and provider. Conversation payloads
remain encrypted. Provider failure must stay outside the WebSocket/RPC path.

Apple references: [APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
[token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
