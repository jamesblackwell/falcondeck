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
| Turn: duration, success, tokens, peak context | Event stream (`TurnStart`, `TurnEnd`, `ThreadTokenUsageUpdated`), followed on its own thread. Input/output tokens come only from providers that report per-request usage (Codex): the change in the cumulative total across the turn, with a baseline taken from the first report when none is known. Claude and ACP report context fill instead, so every turn records its peak context size. |
| File write: thread, path | Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool calls once they complete successfully, and Codex `File` events. Edits made through shell commands and ACP tools are not attributed yet. |
| Bot context: estimated tokens injected per bot turn | Recomputed off the turn path when a bot's home conversation receives a message |

Records store thread and workspace ids; the summary labels them with current
thread titles, bot names and project folder names, falling back to the id for
deleted threads.

## API

- `GET /api/analytics`: settings, folder, and bytes used.
- `POST /api/analytics/settings`: replace settings.
- `GET /api/analytics/summary?days=N`: totals, daily series, agent pairs, latest
  agent messages, files (with days written by more than one thread), per-bot and
  per-provider turns, user messages per project.
- `GET /api/analytics/prompts?query=&limit=`: the user's messages, newest first.
- `POST /api/analytics/clear` with `{"target": "prompts" | "events" | "all"}`.
