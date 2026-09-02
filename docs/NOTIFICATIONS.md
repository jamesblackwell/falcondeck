# FalconDeck notifications and attention

Status: plumbing implemented; external mobile credentials and a real-device
delivery test remain release work.

## Product boundary

The daemon is the source of truth for agent state. Notifications are a
downstream delivery channel for attention events, not a second conversation
store or an inbox. The current semantic events are:

- `input_required`: an approval or user question is waiting.
- `turn_complete`: an agent turn finished successfully.
- `error`: an agent turn failed.

The daemon already emits the underlying interactive-request, thread-status,
turn-lifecycle, and service/error events. A future calm attention screen can
consume those same primitives and retain richer history; push payloads should
remain small.

The packaged macOS desktop app delivers these attention events through
`UNUserNotificationCenter`, so FalconDeck requests real system authorization,
registers with Notification Center under its app bundle identity, and only
deduplicates a notification after macOS accepts it. Other desktop platforms
use the Tauri notification plugin. Desktop delivery follows the same
daemon-owned notification preferences as mobile; browser previews do not
attempt native delivery.

## Current flow

```text
agent provider
  -> daemon event / interactive request
  -> daemon notification policy
  -> remote bridge (E2E session)
  -> relay checks device presence and push token
  -> Expo Push Service
  -> iOS / Android notification
```

Push data contains the session, workspace, thread, and semantic kind needed
for a tap to open the right context. It also includes the thread title so the
OS notification can identify the conversation. Unlike encrypted updates and
RPC payloads, that title is visible to the relay, Expo Push Service, and the
device notification service; no transcript or message preview is included.

The relay suppresses a push to a device with a live relay connection. The
desktop also publishes a short activity lease to the daemon; when enabled,
the daemon suppresses remote pushes while the desktop window is focused. The
lease expires automatically if the desktop crashes, sleeps, or loses focus.

## Preferences

Notification preferences are daemon-owned and included in snapshots and
`preferences-updated` events, so desktop and mobile use the same values:

- master enable/disable;
- completed turns;
- approvals and questions;
- failed turns;
- suppress pushes while desktop is active.

Desktop also has a device-local turn-complete chime, off by default, under
Settings → General → Sounds. It plays on this computer when a thread leaves
`running` for `idle` or `error`, including while the window is focused. It is
not a push, is not synced through the daemon, and does not replace attention
notifications. On the packaged Mac app the picker includes native system
sounds (Glass, Ping, and similar); two small bundled WAVs cover everything
else.

Mobile additionally keeps a local OS-permission/token registration gate. A
device with notifications disabled clears its relay token. Disconnecting also
clears the token before discarding the client credential.

## Relay configuration

The relay uses Expo Push Service by default:

- `FALCONDECK_RELAY_EXPO_PUSH_URL` overrides the send endpoint; an empty value
  disables delivery;
- `FALCONDECK_RELAY_EXPO_RECEIPTS_URL` overrides the receipt endpoint for
  integration tests;
- `FALCONDECK_RELAY_EXPO_ACCESS_TOKEN` adds an optional bearer token when the
  Expo project enables authenticated Push API access.

Delivery retries transient HTTP/network failures, polls Expo receipts, and
clears tokens reported as `DeviceNotRegistered`. It deduplicates the same
session/kind/thread for 60 seconds and retains a one-day TTL on the device
notification so stale task completions do not arrive indefinitely.

## Release and testing checklist

1. The Expo project is `@quizgecko/falcondeck-mobile` with project ID
   `14208bcf-41e5-478e-b88c-386745568d6a`; the existing iOS TestFlight profile
   is `preview-testflight`.
2. Build a fresh physical iOS binary after native notification configuration
   changes, then grant notification permission on the device. OTA updates are
   sufficient for JavaScript-only changes after a compatible binary exists.
3. Verify relay production has outbound HTTPS access to Expo and configure the
   optional access token if enhanced Expo API security is enabled.
4. Pair the device, confirm its push token is registered, disconnect the mobile
   relay socket, run a completed/failed turn and an approval/question, and tap
   each notification to verify workspace/thread routing.
5. Reconnect the mobile app and confirm no duplicate push is generated while
   it is live; toggle preferences on each client and verify the other client
   reflects the update.
6. On macOS, restart the packaged desktop app after installing a build with
   native notifications, trigger an approval/question or completed turn while
   FalconDeck is unfocused, and confirm FalconDeck appears in System Settings
   > Notifications with the configured alert style.

Quiz Gecko's existing Laravel notification stack uses direct FCM tokens and
`NotificationChannels\\Fcm\\FcmChannel`. It is a separate product path and
should not be coupled to FalconDeck's E2E relay plus Expo token registration.
