# FalconDeck notifications and attention

Install [FalconDeck for iPhone and iPad from the App Store](https://apps.apple.com/app/falcondeck/id6760899257) and enable notifications when prompted. This guide covers delivery, preferences, and maintainer release checks.

## Product boundary

The daemon is the source of truth for agent state. Attention events now have
two halves: a durable record in the [notification centre](NOTIFICATION-CENTRE.md),
which is an inbox and history kept by the daemon, and this document's best-effort
delivery of that record to a device. It is still not a second conversation store:
a record points at a thread or review and never copies a transcript. The semantic
events are:

- `input_required`: an approval or user question is waiting.
- `review`: a bot published a review that needs a decision.
- `turn_complete`: an agent turn finished successfully.
- `error`: an agent turn failed.
- `agent_notice`: an agent reported something with no decision needed.

Every event goes through `record_and_deliver_attention`, which stores it and then
delivers it, so anything pushed is also in the history and nothing that gates
delivery can stop a record. Push payloads remain small.

The packaged macOS desktop app delivers these attention events through
`UNUserNotificationCenter`, so FalconDeck requests real system authorization,
registers with Notification Center under its app bundle identity, and only
deduplicates a notification after macOS accepts it. Other desktop platforms
use the Tauri notification plugin. Desktop delivery follows the same
daemon-owned notification preferences as mobile; browser previews do not
attempt native delivery.

The client decides this from what it can see, so it depends on the webview
running. The events socket reconnects with backoff, and the review inbox reloads
on every reconnect. Which open reviews have already alerted is kept in local
storage, so a relaunch neither repeats an alert nor misses a review created
while the app was closed.

## Current flow

```text
agent provider
  -> daemon event / interactive request
  -> notification centre record (always, unless the event is noise)
  -> daemon notification policy
  -> remote bridge (E2E session)
  -> relay checks device presence and push token
  -> Expo Push Service
  -> iOS / Android notification
```

Push data contains the session, workspace, thread, and semantic kind needed
for a tap to open the right context, plus the notification id and, for a notice
with a report, its opaque report id. It also includes the thread title and a
bounded assistant reply preview for completed turns, or a notice's title and
summary. Unlike encrypted updates
and RPC payloads, this display text is visible to the relay, Expo Push Service,
and the device notification service; full transcripts are not included, and
neither are reports, which reach the relay only as end-to-end encrypted blobs.

Reviews also carry `reviewId`, the deep link target. A review may have no source
thread, so `workspaceId` and `threadId` can be absent on those payloads.

The relay suppresses a push to a device with a live relay connection, except for
reviews. A socket can look live for up to the 45 second idle timeout after a
phone has gone, and a review must not depend on that. The client decides whether
to show a push that arrives while it is in the foreground. When desktop
suppression is enabled, the Mac daemon checks the time since the last
hardware keyboard or mouse input across all apps at notification delivery.
Phone pushes resume after two minutes of inactivity. Switching to another app
keeps phone alerts quiet; leaving FalconDeck open does not count as presence.
The check reads elapsed time, without recording keys or mouse positions.

Desktop suppression does not apply to reviews. A review has no deadline that
brings James back to it, and bots publish a few a day, so a phone push costs
little. It still applies to approvals and questions: they arrive in bursts during
active work, the Mac alert is the right channel while he is there, and doubling
each one on the phone would train him to ignore both. `ignores_desktop_activity` in `remote_lifecycle.rs` is the one line
to change if that proves wrong.

On platforms without native idle detection, local client interaction refreshes
a short activity lease. Window focus alone does not keep it alive indefinitely.
The lease also expires if the client crashes or stops reporting.

Desktop alerts are independent of phone suppression. Only a focused, recently
used window actually displaying the loaded task suppresses that task's desktop
alert and marks it read. Settings and Activity do not count as viewing the
previously selected task. Alerts are deduplicated per turn or pending request,
so a later completion or question can notify again without clearing older unread
activity first.

A review alerts on the Mac unless the window is focused and showing that exact
review. Being in the inbox with another review open does not count. Each review
has one Notification Center entry, and clicking it opens the review. If the app
restarts first, the click only raises it.

A review uses `POST /v1/sessions/{id}/notify` rather than the bridge socket,
because a queued socket write proves nothing and the bridge reconnects often. The
daemon retries for up to 45 seconds, inside the relay's 60 second dedupe window,
then falls back to the socket. It also falls
back at once on a 404 from an older relay. The relay dedupes per review, so a
retry cannot double-alert.

## Preferences

Notification preferences are daemon-owned and included in snapshots and
`preferences-updated` events, so desktop and mobile use the same values:

- master enable/disable;
- completed turns;
- approvals and questions;
- failed turns;
- only push when away from desktop (two minutes without Mac input). Reviews
  ignore this one.

These gate delivery, never the record. Reviews follow approvals and questions;
agent notices follow the master switch only, and a `high` notice also ignores the
away-from-desktop rule.

Desktop also has a device-local turn-complete chime, off by default, under
Settings → General → Sounds. It plays on this computer when a thread leaves
`running` for `idle` or `error`, including while the window is focused. It is
not a push, is not synced through the daemon, and does not replace attention
notifications. On the packaged Mac app the picker includes native system
sounds (Glass, Ping, and similar); two small bundled WAVs cover everything
else.

Mobile additionally keeps a local OS-permission/token registration gate. A
device with notifications disabled clears its relay token. The native iOS app
turns push on once, the first time a computer connects, by asking iOS for
permission. Only an explicit choice on its Push notifications toggle keeps it off. Disconnecting also
clears the token before discarding the client credential.

## Delivery health

Settings → Notifications → Delivery shows:

- this Mac's notification permission and last posted alert;
- each paired device's registered provider and the last push result, with the
  provider's failure reason;
- daemon counters since it started: sent, held by desktop activity, off in
  preferences, and lost with no relay connection, per kind;
- Send test notification, which posts on the Mac and pushes to every device with
  `POST /api/remote/notifications/test` → `POST /v1/sessions/{id}/push-test`.

"Not registered" means the relay has nothing to send to, so every alert for that
device is dropped. "Accepted" means Apple or Expo took it, which is as far as the
relay can see. Expo also reports through receipts, about 15 seconds later, and
those update the same record. The test push skips presence
and dedupe and is limited to one per five seconds per session. On a phone the
test appears only when the app is in the background.

Push results live in relay memory and reset when it restarts. Registrations are
persisted, so the provider row survives.

To trace an incident, the daemon logs `attention event` with the kind and policy
decision, and the relay logs `push dispatch` with active, live and recipient
counts, plus `APNs delivery finished` per device. `recipients=0` with
`active_devices=1` is a device with no registration. Older builds logged nothing
on the success path, so history before this change cannot be reconstructed.

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
session/kind/thread for 60 seconds, or the same review or notice when one is
named (so two notices from one thread both arrive), and retains a one-day TTL on
the device
notification so stale task completions do not arrive indefinitely.

## Release and testing checklist

1. The Expo project is `@quizgecko/falcondeck-mobile` with project ID
   `14208bcf-41e5-478e-b88c-386745568d6a`; the App Store build profile and
   update channel are `production`. Optional beta builds are covered in the
   [mobile development guide](14-mobile-app.md).
2. Build a fresh physical iOS binary after native notification configuration
   changes, then grant notification permission on the device. OTA updates are
   sufficient for JavaScript-only changes after a compatible binary exists.
3. Verify relay production has outbound HTTPS access to Expo and configure the
   optional access token if enhanced Expo API security is enabled.
4. Pair the device, confirm its push token is registered, disconnect the mobile
   relay socket, run a completed/failed turn and an approval/question, and tap
   each notification to verify workspace/thread routing.
5. Reconnect the mobile app and confirm no duplicate push is generated while
   it is live, except for reviews, which always push; toggle preferences on each
   client and verify the other client reflects the update.
6. On macOS, restart the packaged desktop app after installing a build with
   native notifications, trigger an approval/question or completed turn while
   FalconDeck is unfocused, and confirm FalconDeck appears in System Settings
   > Notifications with the configured alert style.
7. Publish a review while using the Mac, and confirm the Mac alert and phone push
   both arrive and that each opens the review. Check Settings → Notifications →
   Delivery shows both as delivered.

Quiz Gecko's existing Laravel notification stack uses direct FCM tokens and
`NotificationChannels\\Fcm\\FcmChannel`. It is a separate product path and
should not be coupled to FalconDeck's E2E relay plus Expo token registration.
