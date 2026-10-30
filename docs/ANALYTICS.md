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
- Never on the turn path. Callers serialize one line and `try_send` it to a
  writer thread; when the queue (4096) is full the record is dropped.

## Files

Monthly, append-only JSONL:

- `events-YYYY-MM.jsonl`: compact metadata, no message content (except a
  160-character excerpt of agent-to-agent messages). Deleted after the
  retention window (default 12 months, 1–120).
- `prompts-YYYY-MM.jsonl`: the full text of messages the user sent, with
  project, thread title and provider at the time. Kept until cleared.
- `settings.json`: `enabled`, `record_prompts`, `retention_months`.

Expected size is small: an event is roughly 100–250 bytes.

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

Agents read the same report with `falcondeck_get` resource `automation.health`
(`filters.days`, default 7, at most 90). It is answered on the computer only;
paired remote clients are refused, like the rest of analytics.

## API

- `GET /api/analytics`: settings, folder, and bytes used.
- `POST /api/analytics/settings`: replace settings.
- `GET /api/analytics/summary?days=N`: totals, daily series, agent pairs, latest
  agent messages, files (with days written by more than one thread), per-bot and
  per-provider turns, user messages per project.
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
- `POST /api/analytics/clear` with `{"target": "prompts" | "events" | "all"}`.
