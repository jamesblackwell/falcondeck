# Analytics

A private, local record of how the user and their agents work, for tuning the
system: how much agents message each other (and how much of it is noise), how
work is delegated, which files agents write, how long turns take, and what the
user asks for over time. Viewable in desktop Settings → Analytics.

## Boundaries

- Local only. Records live under `<daemon-state-directory>/analytics/` and are
  read through the daemon's local HTTP API. Nothing is registered as a remote
  RPC, projected into snapshots, or sent over the relay; mobile and remote web
  do not see it.
- Not conversation history. The native agent remains the history store.
  Nothing restores, replays or hydrates from these files. The user-message log
  is a private journal for analysis and search, and can be turned off or deleted.
- The writer never blocks the turn path. Callers serialize one line and
  `try_send` it to a writer thread; when the queue (4096) is full the record
  is dropped. Native OpenCode capture has an awaited source-fetch exception
  described below.

## Files

Monthly, append-only JSONL:

- `events-YYYY-MM.jsonl`: compact metadata, no message content (except a
  160-character excerpt of agent-to-agent messages). Deleted after the
  retention window (default 12 months, 1–120).
- `prompts-YYYY-MM.jsonl`: the full text of messages the user sent, with
  project, thread title and provider at the time. Kept until cleared.
- `usage-YYYY-MM.jsonl`: per-turn, per-model token usage (below). Follows the
  same retention window as events.
- `settings.json`: `enabled`, `record_prompts`, `record_usage`,
  `retention_months`.

Expected size is small: an event is roughly 100–250 bytes.

## Token usage

One `usage` record per finished turn per model, with attribution frozen at
write time (threads get deleted, renamed and re-modelled; the record keeps
what was true when it was written):

```json
{"e":"usage","t":"2026-11-03T09:27:01Z","id":"claude:thread-7:claude-haiku-5-5:1762178821123",
 "src":"live","th":"thread-7","par":"thread-3","root":"thread-1","bot":"bot-9",
 "org":"agent_spawn","ws":"ws-1","prov":"claude","model":"claude-haiku-5-5",
 "in":2,"cr":11886,"cw":18949,"out":4,"think":0,"cost":0.00391,"cost_src":"provider"}
```

- `in` is uncached input, `cr`/`cw` cache read and write, `out` includes
  reasoning with `think` as a subset, `calls` counts model requests when the
  harness reports them.
- Normalisation: Claude's `inputTokens` already excludes cache. Codex and
  Grok include cached reads in their input figure, so cached reads are
  subtracted at record time.
- `cost` is provider-reported when the harness supplies it (`cost_src:
  "provider"`). Grok's `costUsdTicks` is converted at 1e-10 USD per tick and
  marked `cost_src: "provider_unverified"` — the unit fits every observed
  sample but is unconfirmed, so the raw ticks are kept too. Codex and other
  ACP agents report no cost (`"none"`).
- `org` is what created the thread: `user`, `agent_spawn`, `scheduled` or
  `automation`. `bot` resolves through the full spawn chain (a bot's task
  spawning its own sub-task still attributes), cycle-guarded and depth-capped.
- Recording has its own switch (`record_usage`, default on), independent of
  the activity switch, so turning analytics off does not silently stop usage
  accounting. Records dropped by a full writer queue are counted, not lost
  quietly (`dropped_usage_records` in the status response).
- Replayed or re-delivered turns are counted once: the ACP event pump skips
  usage classified as a `session/load` replay when received (an active prompt
  always counts as live), and reading the files
  deduplicates on the record id.
- Claude `result.usage` is only the last API call, not a turn aggregate; the
  aggregate is `modelUsage` (subagents included), or
  `model_usage_since_last_result` when the CLI reports it for long-lived
  processes. A result with only the cumulative `modelUsage` is differenced
  against what the process last reported, reset whenever the CLI process
  restarts. Automation-run usage reads the same aggregate, accumulating
  across a run's results.

| Harness | Capture point |
| --- | --- |
| Claude | the `result` event: one record per `modelUsage` entry, cost from `costUSD`, the turn's `num_turns` as `calls` on the busiest entry only; the cumulative fallback is differenced per process |
| Codex | `thread/tokenUsage/updated`: cumulative totals diffed per turn (keyed by the notification's `turnId`), baselined where the previous turn ended, unchanged totals ignored, all-zero `last` reports skipped; flushed on turn completion (a transient retry flushes its attempt); provider fixed to `codex` and the model snapshotted from the thread's selection at turn start (`turn/started` carries no model field) |
| Grok | `_x.ai/session_notification` (older builds: `_x.ai/session/update`) `turn_completed`: one record per `modelUsage` entry, `costUsdTicks` converted and kept raw |
| Native OpenCode | assistant messages from the admitted input onward, fetched at settlement (including failure/interruption); summed by model, deduped by message id; input and cache counts are already separate |
| Other ACP | the `session/prompt` response `usage` (input, output, and the cache/thought split when sent), model from the thread; Grok is excluded here to avoid double-counting |

Attribution is resolved in a spawned task and the serialized line is
`try_send`ed to the writer thread. Native OpenCode currently makes an additional
awaited `messages_since` fetch before publishing idle/error, including after
failed or interrupted settlement. That source fetch can delay settlement; its
failure logs `OpenCode turn usage capture failed` and produces no usage record.
The rest of the recording path uses already-delivered provider events or
responses. Usage rows label bot names and thread titles at read time.

Capture limitations:

- Codex accumulation is memory-only until a turn completes. A daemon restart or
  shutdown before completion loses that unfinished accumulation; there is no
  shutdown flush, persistent checkpoint, or automatic rollout backfill. A start
  notification for a later turn also replaces an unfinished accumulation. After
  restart, the first report can recover its last request, but cannot reconstruct
  earlier requests in that turn. This applies to orderly shutdown as well as
  abrupt termination; finished-turn coverage does not prove complete token totals.
- Native OpenCode captures the admitted parent session only. Provider-created
  child sessions are not queried or included in the parent's usage records.
- Generic ACP usage remains unproven: no successful billed `session/prompt`
  response fixture has been captured. Cursor and Muse have no observed usage
  records in the investigated data. Existing generic parsing and its tests do
  not establish working coverage for those providers.

## What is recorded

| Record | Source |
| --- | --- |
| User message (`user` or `scheduled`), length | New live `UserMessage` items in `upsert_conversation_item`. Replays, interrupted-turn resumes and transient retries are skipped. Agent messages and a delegated task's first brief are excluded here and recorded below. |
| Agent message: from, to, length, steer/queue, acknowledgement guess, excerpt | `falcondeck_message_thread` after a successful send |
| Delegation: parent, child, brief length | `falcondeck_create_thread` |
| Turn: duration, success, tokens, peak context | Event stream, followed on its own thread. A turn runs from a thread's status entering `running` (or `waiting_for_input`) until it returns to `idle` or `error`, which every provider reports; provider turn events are not used. Input/output tokens come only from providers that report per-request usage (Codex): the change in the cumulative total across the turn, with a baseline taken from the first report when none is known. Claude and ACP report context fill instead, so every turn records its peak context size. |
| File write: thread, path | Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool calls once they complete successfully, and Codex `File` events. Edits made through shell commands and ACP tools are not attributed yet. |
| Bot context: estimated tokens injected per bot turn | Recomputed off the turn path when a bot's home conversation receives a message |
| Wait: how long an approval or question waited on the user | Event stream: a thread's pending approvals or questions (or `waiting_for_input`) until they clear |
| Commit: thread, workspace | Finished shell tool calls where `git … commit` is one of the commands (not `commit-tree`, `--dry-run`, or text that merely mentions it). Each `[branch abc1234] …` summary git prints counts as a commit, even if a later command failed; a quiet commit with no output counts only when the whole line is a successful `&&` chain. Commands behind wrappers such as `env`, `command` or `sudo` count only with git's summary line |

The summary also derives, without extra records:

- What started each turn: the closest earlier message, scheduled message,
  agent message or delegation brief for that thread (within five minutes
  before the turn, or a minute after for messages recorded once accepted, and
  never after the turn ended). Each cue starts at most one turn; the rest count
  as continuing work.
- Time to reply: from an agent finishing a turn to the user's next message in
  that thread, if within three days, counted once per finished turn.
- Scheduled tasks: runs, runs with nothing to do, failures, skips and distinct
  threads per automation, read from the automation run history.
- Commits per day, project and bot. A bot's count includes tasks it created.

Records store thread and workspace ids; the summary labels them with current
thread titles, bot names and project folder names, falling back to the id for
deleted threads.

## Scheduled-task health

The summary lists every scheduled task with runs in the period (and every
enabled one, even without runs): schedule, state, thread mode, runs, runs that
found nothing to do, failures, skips, agent time, threads used and the latest
outcome, with review flags:

- `rarely_useful`: at least 80% of finished runs (six or more) found nothing to do.
- `very_frequent`: 24 or more runs a day.
- `failing`: two or more failures, and at least 30% of runs.
- `thread_per_run`: a `new_each_run` task that used more than three threads.
- `cache_cold_reuse`: reused task with any scanned gap in `(TTL−5min, TTL+30min]`;
  Claude's measured one-hour TTL is currently the only registered TTL.
- `reused_thread_model_pin`: stored model/effort pins targeting a thread not
  owned by this automation (its origin does not name the automation); runtime
  ignores them. Dedicated managed tasks are exempt. Clear both fields, or use
  `new_each_run` with `run_as_bot` for cheaper bot work.
- `bot_home_frequent`: bot home task scheduled more often than every four hours.
- `large_reused_context`: managed/existing task with over 100k context tokens
  observed immediately before a run in the reporting period. Uses the latest
  provider context counters already in memory; Codex input includes cache reads,
  while Claude input and cache reads are added. Unavailable usage stays unknown.
  Older runs do not acquire this measurement retroactively.

`skipped_precheck` runs count as skips (not agent no-action replies). They carry
no model token usage and no thread id. Their outcome records that the approved
local check exited 0 with empty stdout.

Agents read the same report with `falcondeck_get` resource `automation.health`
(`filters.days`, default 7, at most 90). It is answered on the computer only;
paired remote clients are refused, like the rest of analytics.

## API

- `GET /api/analytics`: settings, folder, bytes used, and `usage_health` per
  provider since daemon startup: `completed_turns`, `usage_records_written`,
  `turns_with_usage`, and `missing_usage_turns`. Completion counts follow live
  running/waiting → idle/error status transitions independently of the activity
  switch, while `record_usage` is enabled. Codex transitions count only after a
  fresh provider `TurnStart` event with a real id, or a changed nonzero model-call
  usage report; stale `latest_turn_id` summaries and status-only flips do not
  count. `thread/status/changed` maps provider `active` to running even without
  a turn, so status transitions alone are insufficient evidence of a Codex turn. Written records count successful writer
  appends; multiple models count as several records but one captured turn.
  The mismatch is a diagnostic, not a billing reconciliation: zero-token turns
  can have no record, retries/steer segments may have several captures, and a
  daemon restart resets counters. Settings → Analytics shows these figures.
- `POST /api/analytics/settings`: replace settings.
- `GET /api/analytics/summary?days=N`: totals, daily series, agent pairs, latest
  agent messages, files (with days written by more than one thread), per-bot and
  per-provider turns, user messages per project, and a token-usage rollup by
  bot, harness and model (`usage`).
- `GET /api/analytics/usage?days=N&group=bot|provider|model|thread|day`: token
  usage totals for the period, one row per group value plus overall totals.
  `group=thread` rows also carry per-thread detail: bot, workspace and project,
  origin (`user`/`agent_spawn`/`scheduled`/`automation`, with the automation
  name when it still exists), the dominant provider and model, and the average
  prompt context per model call (`in`+`cr`+`cw` over calls; records without a
  call count contribute one call each).
- `GET /api/analytics/prompts?query=&limit=`: the user's messages, newest first.
- `GET /api/analytics/thread?id=<thread_id>&days=2`: inbound and outbound agent
  messages for one task over a rolling window (1–366 days), newest first, with
  sender/receiver ids, delivery mode and stored excerpts. Returns
  `{ messages, dispatches, analytics_enabled }`; messages are empty when analytics
  is off. Delegation timestamps fill in older spawn origins that predate the
  snapshot's optional `dispatched_at`; new dispatches keep their timestamp in
  the origin even with analytics off. Origins with no known dispatch time are
  omitted from the recent list rather than using their last activity time.
  Used by the desktop Info sidebar; local HTTP only, never a remote RPC.
- `POST /api/analytics/clear` with `{"target": "prompts" | "events" | "usage"
  | "all"}`. Usage has its own target: deleting activity metadata leaves the
  token usage log alone.

## Capture regression evidence (4 November 2026)

The fixtures under `crates/falcondeck-daemon/src/fixtures/` retain usage-only
payloads from direct local protocol probes, with conversation content omitted:

- Grok 1.0.70 stdio: the live method is `_x.ai/session_notification`, although
  `~/.grok/sessions/.../updates.jsonl` still stores `_x.ai/session/update`.
  The captured turn reports 21,541 input, 1,664 cache read, 28 output and
  277,127,200 cost ticks. The old dispatcher never reached its usage parser.
- Native OpenCode: `GET /api/session/<session>/message` for the existing
  `ses_e5da18d09ffedm4Pd7uKHt77K5` session returned assistant messages with
  `tokens`, `model` and `cost`. Recent FalconDeck OpenCode threads use native
  transport, bypassing the ACP prompt-response hook entirely. The two retained
  messages sum to 1,164 uncached input, 748,032 cache read, 620 visible output
  and 63 reasoning tokens: normalized output is 683. An additional HTTP-captured
  fixture has 1,365 visible output and 1,566 reasoning tokens; normalized output
  is 2,931. Native `tokens.output` excludes reasoning, while our `out` includes it.
  A direct ACP probe returned authentication-required, so it cannot establish
  the billed response shape of a successful generic ACP turn.
- Codex 0.166.0 app-server: captured `turn/started`,
  `thread/tokenUsage/updated`, and `turn/completed` agree on turn identity.
  A scan of all rollout files modified since recording began (including rollouts
  created before November) found seven FalconDeck `task_complete` events between
  3 November 14:14 UTC and 4 November 13:03 UTC. Every one matches a usage id:

| Thread prefix | Finished turns (UTC) |
| --- | --- |
| `01a1a173` | Nov 3 14:33:14, 15:34:37, 15:48:56, 15:59:49 |
| `01a19130` | Nov 4 09:01:14 |
| `01a1a65d` | Nov 4 11:49:14 |
| `01a1a670` | Nov 4 12:08:11 |

That completion-only scan established no missing finished-turn records in the
stated interval; it did not check unfinished turns or establish complete token
coverage. Earlier completions in those rollouts predate the recording window;
`codex_exec` CLI sessions are separate from the daemon's app-server sessions.
Codex retains the previous terminal totals as the next start's baseline and
uses a stable thread/turn record id for read dedupe.

A later restart demonstrates the unfinished-turn loss: thread
`01a1a6f3-faf0-7a72-8a75-25e48d716ab6` started turn `01a1a6f3-fbe7` at
14:26:10 UTC on November 4, with no completion. The daemon log records startup
at 14:35:23.586 UTC; the next turn started at 14:35:40 and completed at 14:46:22.
The rollout totals 6,715,479 input tokens including cache; the usage log has
4,487,217, leaving 2,228,262 unrecorded. The accumulator was not checkpointed
before restart. This remains a documented limitation rather than a recovered
or backfilled total.

The Scheduled tasks table shows observed models, a differing configured pin,
recorded tokens (uncached input + cache reads + cache writes + output), and a
hover breakdown. Tokens can be sorted in either direction. With no recorded
usage, the configured pin or current thread model appears muted. Task names
open the Automations editor; review flags have readable labels and fix hints.
Options → Analytics opens this panel directly (default ⌘⇧A; customizable).
The native Mac pilot also has an Analytics destination and the same shortcut.
Usage matches both the run thread and its recorded start/finish interval within
the reporting window. Manual turns outside those intervals are excluded, and a
record matching overlapping runs of one task counts once. Runs missing either
boundary stay unattributed until both are available; retained usage can outlive
deleted definitions.

## Provider usage payloads (facts for token tracking)

Scoping notes live in [usage-tracking-scope.md](usage-tracking-scope.md). Lasting facts:

- Claude `result.usage` is the **last API call only**, not the turn. The turn
  aggregate, including subagents, is `result.modelUsage` (per model, with
  `costUSD`); `model_usage_since_last_result` is the per-result slice.
  `input_tokens` excludes cache.
- Codex `input_tokens` **includes** `cached_input_tokens`. `last_token_usage` is
  per request, `total_token_usage` is cumulative.
- Grok sends per-turn usage, per-model usage and `costUsdTicks` in
  `_x.ai/session/update` `turn_completed`. Generic ACP agents may return
  `usage` on the `session/prompt` response; `usage_update` is context fill only.
