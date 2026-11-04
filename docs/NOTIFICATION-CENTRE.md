# Notification centre

Everything that asks for James's attention lands in a durable, scrollable
history, whether or not a push got through. It is also how agents reach him
when something important happened and no decision is needed, with an optional
long report he can read on his phone while the Mac is asleep.

The daemon owns the records. Clients render them; none keeps its own copy as a
source of truth. See [NOTIFICATIONS.md](NOTIFICATIONS.md) for delivery and
[REVIEWS.md](REVIEWS.md) for the decision inbox.

## Record

`NotificationRecord` (`falcondeck-core/src/notifications.rs`,
`client-core/src/notifications.ts`): `id` (`N-41`), `seq`, `kind`, `title`,
`preview`, `bot`, `thread_id`, `workspace_id`, `created_at`, `read_at`,
`resolved_at`, `target`, `importance`, `has_body`, `body` (single read only),
`report`, `repeat_count`. Optional fields are omitted when empty.

Kinds: `input_required`, `review`, `turn_complete`, `error`, `agent_notice`.

`target` is `{"type":"thread","workspace_id","thread_id"}` or
`{"type":"review","review_id"}`. A notice with a body opens its report; `target`
is then the way back to the source thread.

`seq` is the list order and is bumped when a record is refreshed, so a refreshed
record moves back to the top. Never treat it as a count.

## Storage and retention

`<state dir>/notifications/notifications.json` (versioned, atomic writes),
bodies in `bodies/<id>.md`, written only by the daemon.

- Records older than 90 days are dropped with their bodies.
- At most 5,000 records. Past that, read completions go first, then other read
  records, then the oldest. The newest record always survives.
- A failed write keeps the record in memory and the next save retries. A bad or
  future file is left untouched and the daemon runs from memory, because
  recording must never lose an event to a storage problem or a downgrade. Ids
  restart in that mode, so a notice with a report is refused rather than risk
  overwriting a body the preserved index still points at.

## Record, then deliver

`AppState::record_and_deliver_attention` is the only way an attention event
leaves the daemon; `deliver_attention` has no other caller. Anything pushed is
therefore stored. Preferences, desktop presence and a dead relay gate delivery
only, so a suppressed event is still recorded. A repeat of a known event (same
request, review or turn) records nothing and does not push again, including one
already folded into a thread's row (the row keeps the last 32 folded keys).

A request is published before it is recorded, so a fast answer can arrive first.
The store remembers the last 64 keys resolved with no record, and a late record
is then stored already resolved and not pushed.

### Which turn completions belong

A completion is recorded when **nobody else will tell James and the thread has
actually stopped**. Noise is decided before both steps, so the push and the
history never disagree: these turns no longer push either.

| Turn | Recorded and pushed | Why |
| --- | --- | --- |
| Interrupted by James | No | He did it himself |
| A message is queued behind it | No | The next turn starts straight away |
| Child whose parent set `notify_parent` | No | The parent decides what reaches James |
| Bot automation run (`run_as_bot`) | No | It reports home in its own turn, or stays silent on purpose |
| Automation reply equal to its no-action marker | No | The run found nothing |
| Any other automation run | Yes | Its result is what James scheduled |
| Top-level task or bot home | Yes | Someone is waiting on it |
| Spawned child nobody is watching | Yes | Nobody else will say so |
| No written reply | Yes, "Finished." | A missed completion costs more than one odd row |

Errors and input requests always belong, in any thread.

Being at the desk does not stop a record. It stops being unread: a client
showing the thread marks it read, which reads the record too.

To keep history scannable, **a thread has at most one unread completion row**. A
later completion refreshes it (new preview and time, `repeat_count` + 1, back to
the top) while every turn still pushes. Once read, the next one is a new row.
Errors fold the same way, so a retry loop is one line.

## Read state

Read state lives in the daemon, so it syncs across devices. Each change emits
`control-state-changed` with domain `notifications`; clients refetch.

- Opening a thread (`thread.mark-read`, any device) reads that thread's
  completions, errors and requests. Reviews and notices carry their own content
  and stay unread until opened.
- Answering a request or review (or a withdrawal) sets `resolved_at` and reads
  the record, wherever it was answered.
- Mark-all sends the `latest_seq` the client was showing, so a record that
  arrived after James last looked stays unread.

`needs_you_count` counts unresolved requests and reviews, read or not: reading a
request is not answering it.

## Reading and marking

HTTP (Mac) and relay RPC (phone, remote hosts) return the same JSON.

| HTTP | Relay RPC | Notes |
| --- | --- | --- |
| `GET /api/notifications?filter=&limit=&before_seq=` | `notifications.list` | `filter`: `all`, `needs_you`, `bots`. Default limit 50, max 200 |
| `GET /api/notifications/:id` | `notification.get` (`{"id"}`) | Includes `body` |
| `POST /api/notifications/read` | `notifications.mark_read` | `{"ids":[…]}` and/or `{"up_to_seq":n}` |

The list returns `items`, `next_before_seq` (absent on the last page; pass it as
`before_seq`), and store-wide `unread_count`, `needs_you_count`, `latest_seq`.
Mark-read returns those three counts. An older daemon answers an unknown method
or 404: hide the bell, as reviews do.

Filters: **Needs you** is `input_required` and `review` not yet resolved. **From
bots** is anything with a `bot`, plus every `agent_notice`.

## Agent notices

`falcondeck_notify` is a built-in session tool for bots and tasks. A **review**
asks James for a decision; a **notice** tells him something happened and asks for
nothing.

Arguments: `title` (120 characters), `summary` (200, the push preview), optional
Markdown `body` (64 KB), `importance` (`normal` or `high`). The sender, bot and
source thread come from the call, never from arguments. A bot's notice points at
its current home, so a reply reaches the bot.

- **Normal** follows the usual rules, including quiet while James is at the Mac.
  The record lands either way, and the Mac app shows its own banner.
- **High** also pushes while he is at the Mac. The master switch still wins.

A notice travels like a review: `POST /v1/sessions/{id}/notify` with retries, then
the bridge socket, because a queued socket write can die with the connection. The
relay dedupes a notice by its own id, so a retry cannot alert twice and two notices
from one thread both arrive.

Limits, counted from the store so they survive a restart: 3 an hour, 10 a day and
2 `high` a day per sender (a bot, or one task thread), and 30 a day across all
agents, so a fleet of tasks cannot add up to a flood. A refused notice stores and
pushes nothing, and the error tells the agent when a slot frees and to use its
final reply instead. The same sender repeating the same title and summary within
an hour replays the first record, at no cost and with no second push.

Guidance lives in the always-on instructions (`agent_context.rs`), the bot
defaults (`BOT_DEFAULT_INSTRUCTIONS`), the tool description and the
`falcondeck-mcp` skill. All of them say the same thing: rare by default, and your
final reply already reaches James.

## Reports while the Mac is asleep

A report must be readable when the daemon is unreachable, so a copy goes to the
relay. Pushes are not end-to-end encrypted; relay payloads are. So the push
carries only a preview and an opaque id, and the report goes up as ciphertext the
relay cannot read.

```text
falcondeck_notify
  -> record + body in the daemon store (source of truth)
  -> encrypt with the session data key, PUT to the relay (bounded wait, 5 s)
  -> push: title, summary, notificationId, reportId
phone, Mac asleep
  -> GET the ciphertext, decrypt, check ids, render
```

**Encryption.** The same session data key and AES-256-GCM scheme as relay payloads
(`encrypt_json`), held only by the daemon and paired devices. The plaintext is JSON:
`version` (1), `report_id`, `session_id`, `notification_id`, `title`, `summary`,
`body`, `bot`, `thread_id`, `workspace_id`, `importance`, `created_at`. The ids are
inside the ciphertext because the relay chooses what to serve: **a client must
reject a report whose `report_id` or `session_id` does not match its request**, so
the relay cannot swap one report for another. The `report_id` is random and reveals
nothing about the record.

**What the relay learns.** Session id, report id, ciphertext size, and the times.
It cannot read titles, summaries or bodies from a report. It does see a notice's
title and summary in the push, as it does for every push, which is why agents are
told to keep secrets out of them.

**Relay API.** Bearer auth, as for other session routes. Revoked devices fail
authentication.

| Route | Who | Notes |
| --- | --- | --- |
| `PUT /v1/sessions/:id/reports/:report_id` | Daemon | `{"envelope","ttl_seconds"}`. Rewriting keeps `created_at` |
| `GET /v1/sessions/:id/reports` | Daemon or device | `{"reports":[{report_id,created_at,expires_at,size_bytes}]}`, newest first |
| `GET /v1/sessions/:id/reports/:report_id` | Daemon or device | Adds `envelope`. 404 once expired |

**Bounds.** 256 KiB of ciphertext per report (the 64 KB body cap always fits). TTL
30 days, clamped by the relay. Per session: 500 reports and 32 MiB, oldest evicted
first, because the daemon keeps every report and eviction only loses offline
reading. The prune pass deletes expired reports, and they read as 404 from the
moment they expire. Sessions cascade.

**Capability check.** `GET /v1/push-capabilities` gains `reports`. Without it,
daemons and clients make no report calls and read reports over RPC, so everything
works against a relay that has not been deployed. A daemon writes no state that an
older relay could reject.

**Keeping it correct.** The daemon records which key each hosted report used, by a
hash that names the key without revealing it. `sync_relay_reports` uploads whatever
is not on the relay under the current key and runs after a notice, on every bridge
connection, and after a key rotation. That one pass covers an unreachable relay, a
re-pair, a relay deployed later, and a device revocation: rotating the session key
makes old ciphertext unreadable to the devices that remain, so reports are
re-encrypted under the new key. A revoked device keeps any key it already held but
can no longer fetch anything.

**Reading order on a phone.** Daemon first when connected. Otherwise the relay copy.
If that is missing, expired or undecryptable, say the report is on the computer.
Read state set offline is queued and replayed over `notifications.mark_read`.

## Clients

Both clients refresh by re-reading what is on screen from the head of the list and
replacing it, rather than merging into a loaded tail, so a backlog cannot leave a
gap and a read on another device reaches every loaded row. A list scrolled very
deep therefore costs more pages per refresh. `latest_seq` moves only with a head
read: mark-all covers what James was shown, never a record that arrived since.

- **Mac** (`mac-native-pilot`): a toolbar bell with an unread badge, a popover list
  by day with the three filters and mark-all. Reports and reviews open in the main
  column, with a compact review view (overall response only; per-item decisions
  and evidence previews are not in this client). New agent notices show a native
  banner. It talks to the daemon, so it never uses the relay copy.
- **iOS** (`ios-native-pilot`): a Notifications row in the sidebar with the same
  list and deep links, a detail screen with a typed or dictated reply that goes to
  the source thread as an ordinary message, and the offline path above. A push
  routes by content: a review opens the review, a notice opens its report, the
  rest open the thread.
- Older clients ignore the `notifications` control domain and the new push fields.
