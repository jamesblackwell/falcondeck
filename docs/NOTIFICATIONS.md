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

A review or agent notice uses `POST /v1/sessions/{id}/notify` rather than the bridge socket,
because a queued socket write proves nothing and the bridge reconnects often. The
daemon makes four attempts of up to 8 seconds each, with 13 seconds of waits
between them: about 13 seconds when the relay refuses straight away, 45 at worst,
always inside the relay's 60 second dedupe window. It then falls back to the
socket. It also falls back at once on a 404 from an older relay. The relay dedupes per review or notice, so a retry cannot
double-alert.

Every socket push goes through one queue in memory, and a live session writes it
from there, so a bridge that dies or reconnects cannot take a push with it. The
queue holds 16, each for up to an hour by the wall clock (`Instant` stops while a
Mac sleeps). When it is full, completions go first, then errors and ordinary
notices; approvals, questions, reviews and `high` notices go last, oldest first in
each group, after anything expired. A push stays queued until it is written, so a
failed write keeps its place and its age, and an aborted session loses nothing. The
write runs beside the session, so a slow socket does not stop it reading.

Each push is decided again as it goes out. One whose record was settled meanwhile
is dropped: answered, for a request or review, since opening a thread only reads
those and they still wait on James; read, for anything else. Preferences and
desktop presence are checked as they are at first; `high` notices and reviews skip
presence as usual. Written means the socket took it, so a push can still die with
the connection after that. A restart forgets the queue; the record stays.

## Preferences

Notification preferences are daemon-owned and included in snapshots and
`preferences-updated` events, so desktop and mobile use the same values:

- master enable/disable;
- completed turns;
- approvals and questions;
- failed turns;
- quiet automatic bot work (off by default);
- only push when away from desktop (two minutes without Mac input). Reviews
  ignore this one.

These gate delivery, never the record. Reviews follow approvals and questions;
agent notices follow the master switch and the dispatched-thread push filter,
and a `high` notice also ignores the away-from-desktop rule.

“Quiet automatic bot work” filters phone delivery. Bot-home completions push
only when the logical turn includes a message sent directly by the user, from
any client. Automatic child updates, wake/report turns, peer messages and
scheduled bot runs remain in the centre without a completion push. Explicit
bot notices, reviews, human-only decisions and bot-home errors remain eligible.
Every `AgentSpawn` generation stays quiet, including explicit/high child notices,
except for decisions that need the user. An ordinary child question remains
eligible if its parent is missing, archived, errored, paused or otherwise unavailable.
Threads with fully unknown provenance keep pushing, protecting user-created
conversations. Other event switches and presence rules still apply.

The daemon marks the source at admission, not from message wording or a
client-supplied field. `attention.reply_to_user` is persisted with the thread and
queued request, survives provider hydration, and is retained by resumes/retries.
User steering upgrades the running logical turn before the provider is released;
a definite provider rejection rolls back only that input's provisional claim.
Uncertain transport outcomes keep human eligibility. Concurrent
accepted human input is retained. Review responses, question answers, approvals
and plan feedback delivered by James use the same human attribution; an agent's
answer to its child does not. Editing a queued entry makes it user-authored and
clears its old agent sender, including merged entries. Removing/reordering a
queue or steering an unedited entry changes delivery timing, not authorship.
Automatic input cannot downgrade a human turn. A later provider wake without admission starts automatic work. Completion
pushes capture the marker so a newer turn cannot change an older queued reply.
Missing old per-turn markers count as automatic on bot homes. Legacy queued
entries are different: when the source marker is absent, an entry without an
agent sender counts as James's; one with an agent sender stays automatic.
Explicit saved source values always win. Provenance is restored from
daemon state and, for legacy gaps, unambiguous analytics `delegate` creation
records. Later bot messages and generic handoffs never establish ownership.

The option defaults off, including old configs that omit it. While off, the old
completion notability rules remain unchanged: bot scheduled/no-action runs,
parent-watched completions and queued work do not gain records or pushes merely
because the thread is a bot. Enable it in
Settings → Notifications. It changes phone delivery only: centre records/counts,
parent messages, bot wake-ups and desktop alerts keep their own policies. Native
iOS connected alerts use the same daemon-owned per-turn marker; RN has no
connected local-alert fallback. Native Mac alerts are desktop alerts and are
unchanged. The report-back branch's `is_report_turn` centre noise veto is separate;
its report sender must use `send_automatic_turn` when the branches reconcile.

An ordinary child question whose parent is already unavailable remains eligible
when it is raised. If the parent disappears after the question was suppressed,
this branch does not re-fire it. The separate outcome-tracking work supplies a
two-hour needs-input escalation for tracked tasks; untracked questions remain in
the centre. This is an accepted limit, not a lifecycle re-evaluation service.

For the reviewed 476-row historical sample, the conservative remaining source
eligibility ceiling is **340/476 (71.4%)**. The earlier 204/476 figure was only a
scenario, not an upper bound: mixed turns retain human eligibility, and latest
incoming-message labels cannot prove that a turn was wholly automatic. The
54/476 (11.3%) lower scenario assumes all unknown bot-home turns were automatic.
These are coalesced notification-centre rows, not push receipts or a prediction
of future delivery. The durable marker resolves attribution for new work.

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
- daemon counters since it started, per kind. Every push ends as exactly one of:
  delivered (the relay acknowledged it, or a session wrote it to the socket),
  answered or read before it could go, not sent because of desktop activity, off
  in preferences, expired, dropped for newer ones, or lost with no phone paired.
  Waiting is the number in the queue right now, and it stops counting a push once
  that push ends. `delivered` over the socket means written, not acknowledged;
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

## Known gaps

From the review of the delivery and centre work (November 2026), left for later:

- **Medium: no acknowledged path for approvals, questions or errors.** Only reviews
  and notices use `/notify` (`http_eligible` in `remote_lifecycle.rs`). A frame queued
  on a dying socket is lost, though the record survives. This matches main before
  the centre. Approvals block agents, so they are next.
- **Medium: no relay-wide report quota.** Pairing is deliberately unauthenticated
  (burst 100, then 2 per second globally), and a claimed pairing yields a daemon
  token. Each session can hold 32 MiB of reports for 30 days, in RAM and reloaded at
  boot. Update replay already allows 64 MiB per session for 7 days, so this adds to
  an existing exposure. Not exploited in testing. Add a global cap before opening
  the relay to more users.
- **Low: an unusable store is quiet.** If `notifications.json` is unusable the daemon
  runs from memory with only a log line, and records are lost at each restart.
- **Low: per-thread notice budgets.** Each task thread has its own budget, so spawned
  threads get around the per-sender limit of 2 `high` a day. The 30 a day across all
  agents still bounds it, but those can arrive in minutes.
- **Low: native Mac mark-all ignores the filter.** Desktop and iOS keep to it.
- **Low: an old iOS opt-out cannot be told from never choosing.** Earlier builds
  saved "off" on every launch, so one such install gets push turned on once, if
  the OS permission is already granted.

## Relay configuration

The relay uses Expo Push Service by default:

- `FALCONDECK_RELAY_EXPO_PUSH_URL` overrides the send endpoint; an empty value
  disables delivery;
- `FALCONDECK_RELAY_EXPO_RECEIPTS_URL` overrides the receipt endpoint for
  integration tests;
- `FALCONDECK_RELAY_EXPO_ACCESS_TOKEN` adds an optional bearer token when the
  Expo project enables authenticated Push API access.

Delivery retries transient HTTP/network failures, polls Expo receipts, and
clears tokens reported as `DeviceNotRegistered`. It deduplicates for 60 seconds:
the same review, or the same record and text when the daemon names one (so two
approvals in a thread both arrive, and so does a new answer folded into one
record), or the same session, kind and thread from a daemon that names neither. It
retains a one-day TTL on
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
