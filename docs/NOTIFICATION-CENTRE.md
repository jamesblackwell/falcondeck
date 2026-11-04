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
  recording must never lose an event to a storage problem or a downgrade.

## Record, then deliver

`AppState::record_and_deliver_attention` is the only way an attention event
leaves the daemon; `deliver_attention` has no other caller. Anything pushed is
therefore stored. Preferences, desktop presence and a dead relay gate delivery
only, so a suppressed event is still recorded. A repeat of a known event (same
request, review or turn) records nothing and does not push again.

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
