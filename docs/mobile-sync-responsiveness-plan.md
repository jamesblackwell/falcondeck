Mobile sync responsiveness plan — 5 September 2026

Make the first sync small, service requests independently of bulk transfers,
and resume from a valid checkpoint. Keep the daemon and native agent storage as
the source of truth. This document is a plan; it does not change runtime code.

**Evidence and scope**

The production relay fix in `80f1d0c` was deployed at 21:19 BST. It stops
echoing encrypted updates to daemon peers. The Mac reconnected, but a subsequent
`thread.mark_read` still timed out. Previously, both `thread.detail` and
`turn.start` timed out, with replies arriving after the relay's 30-second
deadline. Increasing that deadline would leave the underlying wait intact.

The Mac logged 5–7.7 MB socket writes taking 15–28 seconds. Those timings
establish a transport stall; they do not by themselves identify whether upload
bandwidth, peer backpressure, or another resource is the limiting factor.
The phone's 96% CPU screenshot also needs a release-build profile before
attributing it to a particular function.

A fresh local measurement from the running Mac found:

| Payload | JSON bytes | Local fetch and decode |
| --- | ---: | ---: |
| Full snapshot | 5,746,790 | 110 ms |
| Current mobile projection | 2,785,314 | 62 ms |
| Threads within mobile projection | 1,925,852 | — |
| Workspaces within mobile projection | 799,564 | — |

There are 39 workspaces and 1,968 non-archived threads in the mobile response;
1,965 of those threads are idle. Agent and workspace model lists account for
about 621 KB combined. Payloads vary with live state; these are a baseline,
not fixed limits. Wire sizes are larger than these plaintext JSON sizes.

The source confirms:

- `remote_bridge.rs::connect_remote_session` awaits socket writes inside its
  read/event/heartbeat loop, including an initial snapshot before entering the
  main request loop. RPC execution is already spawned separately after receipt;
  adding more handler tasks alone will not fix receipt or reply delays.
- `falcondeck-relay/src/api.rs::socket_loop` also awaits outbound writes inside
  the loop that reads incoming requests.
- `snapshot_with_request` builds a full snapshot and then removes fields.
  The requested projection saves wire bytes but still pays the full construction
  cost. Normal snapshot events pass through `remote_event_message` without the
  same trimming used by `publish_remote_snapshot`.
- Preference changes emit both a targeted update and a full snapshot. Other
  restore/recovery paths legitimately emit snapshots and must be distinguished
  from these redundant refreshes.
- Relay replay already has count and byte budgets and approximately 512 KiB
  batches, but an individual large encrypted update exceeds that batch target.
  On mobile, discarded replay snapshots still arrive and are decrypted first.

**1. Establish timings and a repeatable slow-link test**

Extend the existing request-ID diagnostics across the Mac, relay, and client:
enqueue, first write, last write, receive, dispatch, handler completion,
decrypt, parse, apply, and acknowledgement. Record queue bytes/age, message
kind, snapshot reason and revision, and transfer size. Use local monotonic
durations; correlate across machines without subtracting unsynchronised clocks.
Do not log message bodies, keys, or decrypted data.

Use a synthetic fixture matching 40 projects and 2,000 threads, plus a large
tool result, active streaming, and a second connected device. Run it through a
throttled test relay. This separates CPU/lock time from time spent waiting for
socket capacity and exposes whether the slow consumer is the Mac or phone.

**2. Separate reading, dispatch, and writing**

Refactor the Mac bridge and relay socket handler to have a continuously polled
reader, bounded dispatch work, and one writer owner per socket. Start readers
before sending bootstrap or history. Keep heartbeat handling and connection
supervision independent of bulk encoding and writes. Bound CPU-heavy encoding
work; do not move it onto an unbounded collection of background tasks.

Give the writer explicit service classes:

| Class | Work |
| --- | --- |
| Urgent | Connection/key control, heartbeats, approvals, interrupts, small send acknowledgements |
| Interactive | User-initiated requests and small replies; selected-thread state |
| Bulk | Snapshot pages, old history, catalogs, replay and large artifacts |

Priority applies to eligible messages; it must not reorder durable events or
key-rotation/bootstrap dependencies. A large `thread.detail` result remains
bulk data even though its initial request is interactive. Reserve capacity
for urgent work, use byte limits as well as count limits, and give bulk work a
minimum share so it cannot starve. Collapse pending mark-read updates to the
newest sequence per thread before issuing them; coalesce only state that is
explicitly replaceable. Never discard accepted mutations or approvals.

Replace the daemon's unbounded RPC result queue with byte-accounted admission
and bounded execution. A full bulk queue pauses its producer rather than the
reader. Exhausted mutation capacity returns an explicit rejection before
execution; accepted work retains a path to its result. A disconnected or
revoked generation cancels transport work and releases permits. Preserve the
existing old-key-generation checks and avoid retrying mutations merely because
a transport timed out.

**3. Make bulk transfers interruptible between small messages**

Reader/writer separation alone is insufficient: an application reply cannot
overtake a large WebSocket data message already queued on the same TCP stream.
WebSocket frame fragmentation alone does not permit interleaving another data
message. Use bounded application messages and schedule between them.

Negotiate a new bulk-transfer capability in the relay protocol before enabling
it. Start with a 16 KiB maximum encoded wire chunk, one active bulk transfer per
peer, and at most two unacknowledged chunks. The receiver grants more credit
after consuming chunks. Measure and tune these starting budgets; do not fill
the socket buffer with an entire snapshot ahead of urgent replies.

Keep each logical page small as well: chunking a 7 MB JSON object and then
joining and parsing it synchronously on the phone would preserve the UI stall.
Page by encoded bytes and record count. Fetch oversized individual tool outputs,
diffs, and attachments through bounded artifact ranges instead of embedding
their entire content in a sidebar or history page.

Transfers need a transfer ID, generation, logical page/event identity, chunk
index/count, size limits, cancellation, and an expiry. Bind routing and ordering
metadata to the authenticated payload and use a fresh AEAD nonce per encrypted
chunk. The relay stays blind to plaintext. Bound reassembly per peer and in
aggregate; reject inconsistent, oversized, or incomplete transfers. Commit a
logical event or checkpoint only after its complete authenticated payload is
available. Retention must either preserve a complete replayable logical update
or explicitly require recovery; partially retained transfers are not valid replay.

Implement shared contracts first in `falcondeck-core` and `client-core`, then
the relay, daemon, mobile, and remote web. Keep the legacy format for peers
that do not advertise support. Priority/credit metadata is not an authorization
mechanism and remains subject to each peer's normal quotas.

**4. Replace full mobile bootstrap with a compact, paginated index**

Add a negotiated sync API rather than silently changing the meaning of
`snapshot.current`. Preserve the old API for existing clients.

The initial view contains project metadata/counts, the selected thread,
actionable approval/turn summaries, and a byte-limited page of recent thread
rows. Start with up to 50 recent rows. Pinning, running threads, and pending
approvals remain discoverable through dedicated counts/pages if they exceed
the first-page budget. Older threads are fetched when a project expands or the
user scrolls/searches. Absence from a page means "not loaded", not "deleted".

Define compact row types containing fields the list actually renders. Keep
history, full plans/diffs, native session metadata, and full error details in
detail endpoints. Do not remove data from the daemon or underlying agent.
Build the compact projection directly, without cloning the full snapshot first.

Send identical model/skill/capability catalogs once per content revision and
reference them from workspaces; do not assume all workspaces share the same
configuration. Fetch other catalogs on demand. Retain the selected provider,
model ID, and available persisted settings so an uncached catalog does not
silently change the user's send options. Validate those selections at the daemon.

Use the same projection rules for requested pages, pushed updates, bootstrap,
and recovery. Legacy clients retain their existing full fields. Existing mobile
changes that hide archived threads are already in another agent's uncommitted
edits; coordinate with them rather than overwriting them.

**5. Resume a coherent view instead of repeatedly replacing it**

Introduce a versioned sync token covering daemon epoch, projection/schema,
scope, and a committed state revision. Bind pagination to an immutable snapshot
revision with a bounded lifetime. A page request cannot silently switch to a
newer snapshot halfway through loading the list.

The revision must represent a real consistency boundary: publish it together
with the derived projection update. Do not stamp the current atomic event
counter onto today's independently locked `snapshot()` and assume it is an
atomic snapshot. A versioned in-memory projection is a disposable cache of
daemon state, not another conversation database.

On reconnect, validate the cached view's token. With a matching epoch/schema
and sufficient replay coverage, send only changes since that checkpoint. On
first use, incompatible state, missing cache, truncation, or overflow, request
one fresh compact snapshot. Foregrounding or a successful rekey alone does not
invalidate an otherwise valid cached view.

Keep daemon revisions separate from relay sequence numbers. Establish the
mapping using an ordered sync barrier, buffer later events while applying the
base, and replay them in order. Advance the durable relay checkpoint only when
the corresponding base/pages and dependent updates are applied and persisted.
Partial caches must declare their coverage and revalidate missing scope; do not
claim that a saved cursor proves a complete view exists.

Replace redundant remote full snapshots with existing targeted events where
they completely describe the change, such as a preference update. For changes
without a complete delta contract, send one small invalidation and fetch the
affected scope. Keep only the newest unsent snapshot per compatible scope and
generation. Multiple retry/lag signals join one recovery operation; an update
during recovery is buffered or marks that operation dirty, not a request to
start another full transfer. On bounded-buffer overflow, explicitly resynchronise.

**6. Apply incrementally on the phone and prove the result**

Keep RPC acknowledgement processing separate from the bulk decrypt/apply queue.
Retain the native asynchronous AES backend. Parse bounded pages, apply them in
short batches with yields, and update only affected store selectors/rows. Keep
the composer and cached content usable during catch-up. Persist bounded batches
away from per-token rendering; cancellation discards stale generation results.

Measure JSON decode, normalisation, store update, React commit, and cache write
separately on a physical iPhone running a release/TestFlight build. Start with
an 8 ms batch work budget and a hard investigation threshold of 50 ms for a
single synchronous JS task. If a bounded page still exceeds it, reduce its
size or move the measured hotspot off the JS thread. Do not infer the cause of
the 96% reading from an encryption-only simulator benchmark.

Show connection health separately from sync progress and message delivery.
Background mark-read failures belong in diagnostics. A send whose acceptance
is unknown needs delivery reconciliation; transport optimisation does not make
blind retries safe. Stable logical message IDs remain a companion send-flow
task, not a prerequisite for moving bulk bytes more efficiently.

The following are proposed release targets, to be checked against the same
fixture and supported physical iPhone throughout development:

| Measure | Target |
| --- | --- |
| Initial usable index for the 40-project/2,000-thread fixture | At most 128 KiB of encoded transfer; remainder paged |
| No-change warm reconnect with a valid cache and retained history | Zero full snapshots and zero catalog retransfers |
| Fresh recovery | One concurrent recovery per client/scope; no redundant push plus RPC snapshot |
| Bulk queued ahead of interactive work | At most two 16 KiB wire chunks |
| Daemon dispatch after complete request receipt | p95 under 50 ms under bulk-sync load, excluding the handler itself |
| Small test RPC during bulk sync | p95 under 500 ms on normal Wi-Fi; under 2 s at 512 kbit/s and 150 ms RTT, excluding agent startup |
| First useful index at 512 kbit/s and 150 ms RTT | Under 5 s after the encrypted session is ready |
| Typing while receiving history | p95 input-to-render under 100 ms; no synchronous sync task over 50 ms |
| Correctness | No lost acknowledged actions, stale snapshot overwrite, or cursor beyond applied state |
| Resource use | Queue, reassembly, and recovery memory plateau at configured byte budgets under a stalled peer |

Tests must include a blocked writer while an incoming RPC arrives, urgent work
between bulk chunks, fair progress under sustained priority traffic, duplicate
or missing chunks, replay pruning mid-transfer, snapshot/delta races, epoch
changes, key rotation/revocation, crash between apply and checkpoint, two devices
with different capabilities, large single artifacts, and background/network
switches during sync. Interrupts and approvals must remain usable during the
same scenario. Test mutation acknowledgement loss without automatically retrying
the mutation. Extend `docs/remote-sync-qa.md` and the existing relay/bridge/client
integration suites rather than relying only on a throughput benchmark.

**Delivery order**

1. Add timings and the throttled regression harness; capture the baseline.
2. Introduce the shared capability/schema contracts and independently serviced,
   byte-bounded transport queues. Keep new protocol paths disabled by default.
3. Implement and test compact index pages, revision-bound recovery, and chunk
   scheduling together. These jointly remove both oversized work and waiting
   behind it. Adopt the shared parser/assembler in mobile and remote web.
4. Replace redundant snapshot producers, add checkpoint resume, and profile
   incremental mobile application with the real fixture.
5. Run focused checks and the repository-required autoreview on each significant
   completed change; fix verified findings. Roll out the backward-compatible
   relay first, coordinate the Mac rebuild/restart with James's other agent,
   then release mobile via TestFlight and the aligned remote web client.

Advertise new capabilities only after both ends support them; test mixed-version
devices and keep a rollback switch to the legacy protocol. Enable for one
paired phone first and compare request latency, snapshot count/bytes, reconnect
success, and UI responsiveness before broader activation. Do not restart the
Mac from this planning task. Compression is a later measured option, after
removing repeated data and proving bounded scheduling; it cannot replace either.
