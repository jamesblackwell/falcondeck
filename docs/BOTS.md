# Bots

Bots are named coordinators outside the project hierarchy. Each profile points
to one native agent conversation, with editable instructions and a local
document space. Tasks delegated by a bot remain ordinary FalconDeck tasks in
their target projects. The daemon stores bot metadata, not conversation history.

## V1

The desktop and browser sidebar has a Bots section. Create a new conversation or
promote an existing task (including a pinned task), choose its name and standing
instructions, and use its settings to manage documents and delegated work.
The native Mac sidebar exposes the same operations, including adding a text
document and opening its space in Finder. Harness and model settings for an
existing home conversation remain in the usual conversation controls.

New bots live under `<daemon-state-directory>/bots/<bot-id>/`, with user-owned
documents in `space/`. Promoted conversations retain their native workspace and
session; only their document space is new. No project hierarchy is required.
Documents are ordinary files, so changes made outside FalconDeck are visible on
the next read. The built-in editor supports UTF-8 files up to 1 MB and detects
conflicting saves/deletes using content versions. New filenames never overwrite
existing files. File operations reject traversal and symlink documents.

Every dispatched home turn receives the current coordinator defaults, custom
instructions, document inventory and project identifiers. It reads document
contents as needed. This context is hidden from the user message bubble and is
supplied again after native resume or compaction. Native conversation history
stays with the harness.

Bots link to tasks using `[Task name](falcondeck://thread/THREAD_ID)`, with
the exact `thread_id` returned by the coordination tools. Selecting the link
opens that task in FalconDeck, including in another project on the same computer.
The destination uses the stable ID, so renaming a task does not break old links.

Bots are encouraged to use their document space as persistent memory. A short
root-level `MEMORY.md` (or an existing memory index) holds important facts,
preferences, decisions and editable working instructions, with links to
supporting notes. Bots can organise those notes themselves, including
`memory/` or `docs/` subfolders. They consult the index when present and read
supporting notes when relevant, especially after resume or compaction. They
update useful knowledge rather than writing a log of every turn, and the user's
current and standing instructions still take precedence. No files are created
automatically. The built-in document editor lists top-level files; nested notes
are accessed directly by the agent or through the filesystem.

Current work lives in a root-level `STATUS.md` instead: priorities, in-flight
tasks (linked), what waits on the user, and recently done. Bots rewrite it in
place at checkpoints rather than appending. When a delegated task finishes, the
bot reads its summary, records the outcome in status, moves lasting decisions or
lessons into memory, and drops the task from in flight. Tasks record lasting
facts about code in their project's own docs. Each layer has one job: tasks
hold the work and its history, status holds the present, memory holds what
stays true.

The desktop Info sidebar shows a bot's name and mark, then its rendered
`STATUS.md` (about twelve lines until expanded). The document API includes
`modified_at` so the sidebar can flag status older than a day. Below it are
recent dispatches and messages, open tickets owned by the bot, and schedule
cards targeting its home or directly dispatched tasks. Schedule switches use
the read revision and retry one stale-revision conflict. Selecting a card opens
the existing automation editor. Environment and checkout rows sit in collapsed
Details. Ordinary tasks retain their existing Info layout plus recent activity.
Reads follow task updates, coalesced while streaming; there is no idle polling.

Every turn's context lists the other bots by name with the path of their
`STATUS.md`, so bots read each other's status instead of asking for updates.
Bots and tasks message each other only for decisions, blockers, review
requests, results or surprises; acknowledgements and progress narration are
discouraged.

## Tickets

Retired 2 Nov 2026 (see [TICKETS.md](TICKETS.md)); bots are no longer told about the board.

Bots are told the shared ticket board exists and how to reach it, and left to decide whether and how to use it (an experiment from 30 Oct 2026). Agents may create at most five tickets a day each. See [TICKETS.md](TICKETS.md) for tools and the board.

## Icons

Each bot has a small colored shape in the sidebar: one of eight shapes and one of
the twelve categorical theme colors (`cat-1`…`cat-12`, stored as the token so
it retints with the theme). New bots take the first shape and first color no
other bot uses; profiles saved before icons existed are filled in the same way,
in order, the next time any bot is saved (clients resolve missing icons the same
way meanwhile with `resolveBotIcons`). Bot settings can change either part. An
activity marker replaces the status text while the bot or its tasks are working.

## Context files

Each bot can list text files (`.md`, `.markdown`, `.txt`) that are read fresh
from disk into every one of its turns, after its instructions and before the
document, peer and project lists. Use them for shared standing context such as
company goals, metrics or brand notes: a handful of short files, mixed per bot.
Files can live anywhere. FalconDeck suggests everything in its own context folder
(`<daemon-state-directory>/context/`, created on first use) and well-known files
at project roots (`COMPANY`, `VISION`, `MISSION`, `GOALS`, `STRATEGY`, `METRICS`,
`BRAND`, `ROADMAP`), so a project can keep its own version and different bots
can share or swap files. Tasks started by bots do not receive them; bots brief
their tasks instead. Repository instructions such as `AGENTS.md` continue to reach
every coding thread through the harness itself.

Each file is capped at 64 KB per turn; a missing or unreadable file is noted in
the turn instead of failing it. Saving a bot validates the list (absolute paths,
existing regular files, at most 20). Bot settings show each file's estimated size,
the total added to every turn (about four characters per token), a per-part
breakdown and the exact injected text. Settings can also create files in the
FalconDeck folder and edit any suggested or attached file with the same version
checks as bot documents; other paths are not readable or writable through this
editor. Bots are told to suggest changes rather than edit these files unless their
instructions say otherwise. That is guidance, not a sandbox.

## Coordination and control

Project threads find bots in the `falcondeck_list_threads` header (name and
thread id) and can message one by name: any tool's `thread_id` accepts a bot's
name, case-insensitively, when no thread has that id. They cannot read a bot's
conversation; trying returns an error that names the bot and says to message it.

Bot calls to the built-in coordination tools can select a project using
`workspace_id`: its id, exact path, or unique folder name. Calls identifying an
existing task resolve its owning workspace automatically. List and changes
calls without a project span every project, so "what is going on?" takes one
call. The per-turn context lists only the twelve most recently active projects
(path and id), since it is repeated on every turn. Ordinary tasks remain workspace-scoped. The concurrent
children limit (`max_agent_children`, default five, Settings → General → Parallel tasks per agent) counts all projects together. Bot delegations and follow-ups now have durable daemon-owned outcome tracking.
See “Durable delegated outcomes” below for delivery levels and waiting semantics.

“Allow this bot to start tasks through FalconDeck” is enforced when its
coordination tool is invoked. This is a FalconDeck capability restriction, not
an operating-system sandbox or a restriction on running arbitrary shell commands.
Existing harness permissions and approval rules continue to apply.

Stop work clears queued requests and interrupts the bot and its direct workers.
Pause does that and leaves the bot in the sidebar. Its schedules wait without
recording a run, and other bots cannot message it. Archive does the same and
moves the bot out of the working list. Resume or unarchive puts it back.
Documents, instructions and the home conversation stay either way. Deletion
requires that work to be stopped, removes the profile, and archives the
home conversation. Documents remain on disk. Bulk archive skips bot homes;
individual archive/delete and project removal cannot strand a registered bot.

## Client contract

Profiles are carried in `preferences.bots`; older snapshots default to no bots.
Mutations use `POST /api/bots` with `create`, `update`, `reorder`, `stop`, `set_status`, or `delete`. `set_status` takes `active`, `paused`, or `archived`. Older profiles omit `status`, which means active. Bots are listed in their saved order; `reorder` takes ids first to last, and bots it omits keep their relative order after those listed. Desktop reorders by dragging a row or Alt+↑/↓.
Document listing, reads and mutations use `/api/bots/:id/documents` and
`/api/bots/:id/documents/content?name=...`.

Context files use `context_files` on the profile (absent on older daemons) and an
optional `context_files` list in `update` (absent keeps the current list).
`GET /api/bots/:id/context` returns the injected text with a size breakdown;
`GET /api/context-files` lists suggestions, and
`GET /api/context-files/content?path=...` and `POST /api/context-files` read and
save them.

Paired clients use registered encrypted RPCs `bots.mutate`, `bots.documents`,
`bots.document.read`, `bots.document.mutate`, `bots.context`,
`context_files.list`, `context_files.read` and `context_files.write`. Clients hide
the context-file section when a daemon does not answer these. Profile changes publish the
existing `preferences-updated` event. No relay storage or replay contract changes
are needed.

The SwiftUI iOS client includes a Bots sidebar section. Open a bot's home
conversation or use its settings to create and promote conversations, edit
instructions and delegation access, stop work, remove a bot, and create,
import, edit or delete text documents with the same content-version checks.
Dedicated bot workspaces and home conversations stay outside the ordinary
project and pinned-task lists; promoted projects remain visible. Documents
stay on the paired computer and require a connection to read or change.

## Switch harness / fresh start

Bot settings → Switch harness chooses a provider and model, then confirms a
fresh home conversation. Choosing the current harness also gives a fresh start.
`POST /api/bots` accepts `{"action":"switch_conversation","id":"bot-id",
"provider":"codex","model_id":"model-id","reasoning_effort":"high"}`.
James can use control MCP operation `bot.switch_conversation` with the same
arguments except `action`. Bot callers are refused. A running, waiting, queued
or background-active home must finish or be stopped first. No seed turn runs:
the continuity briefing accompanies the next actual message.

The profile keeps `previous_thread_ids`; old addresses deliver to the current
home, and old task origins still identify their coordinator. Old conversations
are archived. Explicit/current and already-created managed automation targets,
model/permission settings, folder membership, pins and unread state follow the
home. Tickets retain their bot-name owners; historical analytics and source
thread links retain their original ids. Watches keep their original parent id
and resolve the current destination when delivering. Startup reconciles archive
and automation writes after a crash between the separate durable stores.

Continuity briefings are capped at 64,000 UTF-8 bytes: document-space references
(standing state is read fresh), delegated tasks (8 KB), recent complete items
(40 items / 28 KB, oversized final items visibly truncated), older-history
commitment/decision/pending-ask evidence (up to 1,200 items, 4.5 KB/category),
and harness memory (8 KB). Claude project memory files and Codex's shared memory
indexes are bounded exports, not a transfer of native memory storage. Keep
lasting facts in the bot's harness-neutral `MEMORY.md`.

### Long-thread measurement (31 Oct 2026)

Read-only exports from the live loopback daemon (29–31 Oct history), replayed
through the old 40-item/12,000-character tail generator and the new briefing:

| Bot | Source items | Before, bytes | After, bytes | Older items scanned |
| --- | ---: | ---: | ---: | ---: |
| Atlas | 381 | 11,594 | 38,194 | 341 |
| Iris | 343 | 11,258 | 37,944 | 303 |
| Libra | 760 | 11,601 | 42,888 | 725 |

All three older scans reached the start of available history. Atlas's earlier
design-instruction decision and Libra's day-23 follow-up commitment were absent
from the old tail and present in the new evidence. Iris's SEO ownership and
landing-event coordination survived both. Raw tool output/diffs, older prose
beyond the category budgets, and some details of long messages are omitted;
source item ids and document references provide recovery. These snapshots had
no directly attributed child origins or native-memory files: task links in
STATUS.md remain authoritative, and fixture tests cover child reports and
memory-section budgets. No live bot was switched and no daemon was restarted.

## Fresh scheduled bot runs

This is a per-schedule choice. Keep `existing` / `current` for work needing the
home conversation's history. For routine checks use `thread: {"kind":"new_each_run"}`
and `target.run_as_bot: "<bot-id>"`. Existing schedules keep their targets.

Fresh runs receive the bot's current standing context, identity, harness and
permissions. An explicit schedule model overrides its home model. The first
prompt includes a bounded local delta since the previous successful run:
home messages, delegated tasks and owned tickets (including closures).
Write escalation criteria in the schedule: send one message home by bot name
when those criteria are met; otherwise update STATUS.md and finish silently.
The run title names the bot and schedule. Successful settled bot runs are archived automatically;
errors and input requests remain visible. Ordinary fresh schedules retain unread findings.

Bot runs skip overlaps regardless of the schedule's overlap setting; missed
occurrences follow the existing skip/run_once policy and never replay a backlog.
`target.only_when_changed` opts into a recorded `skipped_unchanged` outcome
without inference when local home/task/ticket state is unchanged. Leave it off
for external monitors: a website, metric or disk can change independently.
Run history includes provider input/cache token counts when reported; missing
counts mean unavailable, not zero.

## Durable delegated outcomes

Bot calls to create and message register daemon-owned interest, including reused
threads and follow-ups to other bots' workers. Creation without a prompt waits
for its first turn. `daemon-state.delegations.json` is an atomic, owner-only
coordination outbox; native harnesses still own conversation history.

`result_delivery` is `batch` by default on both tools. It controls **plain
completions** only: next home turn for `batch`, or a batched wake for `wake`.
A follow-up preserves an existing stronger wake setting. Failures, input
requests, interruptions and overdue deadlines request wakes under either policy.
A synchronous dispatch rejection is returned directly to the calling bot and
leaves an informational report; it does not add a duplicate wake.
`notify_parent: true` retains its legacy completion opt-in. Non-bot callers keep
the older session-local watcher. Paused and archived bots are never woken.

Only the bot's current home receives reports. `falcondeck_acknowledge_results`
removes the supplied report_ids after reading; fresh scheduled runs cannot take
home reports. Native provider startup must succeed with those reports in its
context before receipt is recorded. ACP waits for startup for such a turn.
Failed sends retain the outbox and retry with a five-minute cooldown without
spending the paid-turn budget. One accepted report turn stops immediate retries.
A home turn dying before acknowledgement still leaves its reports available.
Delivery and retention are bounded; there is no exactly-once guarantee.

Automatic accepted report turns share a three/hour, six/day budget per bot.
Dispatch runs independently of the monitor. After 30 seconds its lease expires,
but the owned send continues through provider admission and cleanup; cancelling
that future could otherwise strand a home on Running. Report details appear in
at most three accepted home contexts, then collapse to a short pending count.
Exhausted details do not outrank new results. A daily digest covers open work
and unacknowledged outcomes at least 24 hours old, including closed batch
completions, failures, missed deadlines and deleted tasks. It uses a rolling day
and stable per-bot staggering, not a UTC-midnight fan-out.

When an urgent outcome has not reached an accepted home turn after two hours,
the daemon raises one durable notification to James. Several such outcomes are
coalesced per bot, sweeping all pending urgent outcomes into at most one alert
per hour. Answered input requests are retired before escalation. It names the bot, task and required check, is attributed to
the actual bot home, and remains phone-eligible under bot-only push. Master
notification preferences still apply. Paused, archived, capped or unavailable
homes do not prevent this escalation. Receipt, acknowledgement and escalation
are separate states. A report already acknowledged needs no escalation.

A task declares `falcondeck_task_state` with `state: waiting`, reason, and a
future RFC3339 deadline. Polling a wait does not wake the coordinator. A reported
idle wait is not re-interrupted on restart. A missed deadline emits one urgent
outcome, clears the wait and closes that interval. Renew the wait or explicitly
re-message before continuing. Declaring a wait on a terminal finished task
returns an error. Each distinct input request is urgent, including a second
approval in the same turn. `finished` closes work; a bot's declaration does not
wake itself merely to acknowledge the declaration.

An unmarked idle turn is completion unverified. Its same-turn background-resume
watch lasts up to seven days within the 200 closed-record cap. Pending jobs
must declare their wait before parking to retain an open watch.
Open running/waiting tasks never expire or get evicted by capacity limits. Work
open more than seven days generates one urgent progress check and remains
tracked. Closed metadata lasts seven days, capped at 200 records per bot.
Ordinary reports expire after seven days; unreceived urgent reports remain
until received or escalated. Retention losses appear in home context.
Tracking storage failure does not reject a message: dispatch continues and a
deduplicated notification identifies the lost watch.

Arm a timed wake before parking for a job or time. If the harness has no
background wake, use a one-time daemon automation in the current thread. If
scheduling is unavailable, explicitly hand resumption to the owner. A detached
shell process alone cannot resume an agent. Inspect external jobs before
retrying side effects. Tracking adds no automatic worker retry. Report wakes
also never replace a shutdown-interrupted home, even with auto-resume off:
James's explicit resume decision is preserved and the two-hour escalation is
the fallback. Configured native recovery remains free to resume it.

Upgrade registration uses restored creation ancestry and recorded delegation
or message relationships, including scheduled-run children and reused threads.
A message watch does not change a reused thread's creation ownership. Metadata
cannot recover unrecorded intent: re-message older work that still needs a watch.
Archived threads are excluded. Historical idle tasks produce one quiet count per
bot, without a wake or daily reminder; they do not request an outcome review.
An unreadable ledger is quarantined, James gets one recovery notice, and each
bot gets one recovery report instructing it to check/re-message pending work.
Historical upgrade notifications are not replayed after quarantine.

Internal report completions stay quiet. A direct-user turn that absorbs a later
report keeps its user-reply notification. Real bot-home errors remain eligible;
only routine internal report noise is suppressed. Paused owner bots never hide
the worker's ordinary notification, and peer home replies remain James-visible.

Normal completion batching adds no immediate wake under defaults. Attention
outcomes and one daily unresolved digest can add paid turns, within the shared
three/hour, six/day cap. Failed wake sends retry no more than hourly. Historical intent is absent from old thread history,
so a precise retrospective wake estimate is not defensible.

### Known delivery limits

Pending reports force provider startup acknowledgement, so a direct message to
that home also waits for ACP startup. Escalation deliberately includes resting
bots. A deleted bot currently falls back to the name FalconDeck and an empty
home source. An unresolved task can cost one digest wake per day until resolved.
An accepted turn that immediately dies has already cleared its reports' wake
and escalation eligibility: later home turns still carry them, and the home
error follows the normal notification path. These limits are deferred, rather
than guarantees of durable execution after provider acceptance.


## Idle context maintenance

General → Agents → Compact idle bot homes is on by default. Active Claude
homes with at least 150K live context tokens can compact after 50 idle minutes,
only before their cache expires and without running or queued work. Disable
`bot_idle_compaction_enabled` to opt out. See the [policy, tests and savings
estimate](token-efficiency-implementation.md#idle-bot-home-compaction-3).
