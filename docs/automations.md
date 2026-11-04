# Automation cost controls

The daemon validates schedules deterministically. MCP creates and updates to a trigger or target must
repeat no more often than every 30 minutes. For reused tasks (managed, existing,
or current), a known cache TTL also rejects any scanned gap in `(TTL − 5 minutes,
TTL + 30 minutes]`. Claude's measured main-conversation TTL is 3600 seconds;
other providers have no registered TTL. Use a 3000-second (50-minute) interval
or `new_each_run` for Claude. This is a cadence heuristic, not a guarantee that
a cache survives downtime, provider changes, or context edits.

Bot home conversations (`bot.thread_id`) require at least four hours between
agent-scheduled runs. Prefer `new_each_run` with `target.run_as_bot` so each run
receives the existing bounded bot digest instead of the entire home context.
Desktop authors may save these schedules and receive warnings with fixes.
`automation.advice` reads accept `filters.trigger` and `filters.target` and return
the same advice without changing any definition.

Intervals use an elapsed UTC grid anchored at `anchor_at`. Optional
`active_window` filters ticks by local time: `timezone` (IANA), `start_minute`
(inclusive), `end_minute` (exclusive), and nonempty ISO `weekdays` (Mon=1).
For example 08:00–17:00 weekdays uses 480, 1020, and [1,2,3,4,5]. Windows cannot
cross midnight, and the interval cannot exceed the window duration. Skipped
ticks do not reset the grid. DST changes the local tick times, not the elapsed
interval. Cron retains its existing semantics: skip nonexistent wall times,
run ambiguous times once at the earlier instant.

Gap checks simulate fourteen days from the first future occurrence, or 62 days
when cron restricts day-of-month or month,
using the scheduler’s timezone and DST semantics. Cron parses once and scans
local calendar occurrences directly; guards stop when disqualified. Advice,
agent validation and health scans run on the blocking pool, off async workers.
Renames and task-only edits do not revalidate cadence on older saved schedules. Sparse schedules with fewer than two
occurrences in that window have no gap-based advice. The editor's 50-minute
cron conversion is offered only for contiguous hours without month/day-of-month
constraints, preserves weekdays and timezone, and uses the selected hours as a
window (for `8-17`, 08:00 inclusive to 18:00 exclusive). Other cron schedules
can use a fresh task without changing their calendar constraints.

Existing saved automations are never migrated or rewritten by these controls.

## Model and context size

`target.model_id` and `target.reasoning_effort` are allowed for managed tasks,
with or without a remembered thread id, and for `new_each_run`. Creates and
target updates reject either field for existing/current targets. For cheaper
bot work without switching a home conversation's model, use `new_each_run`
with `run_as_bot`.

At dispatch, the scheduler applies pins when it creates a native task or when
the thread's `ThreadOrigin::Automation` names this automation. Dedicated managed
threads therefore retain their pinned model across runs and editor saves.
Otherwise the thread's own model and effort win, even if a managed id points at
an unrelated thread. Bot harness switches clear model/effort pins when repointing
automations to a home thread they do not own.

`automation.health` reports `reused_thread_model_pin` for stored pins targeting
a thread this automation does not own, including pins equal to its current
model. Its one-line hint recommends clearing both fields or using fresh bot
runs. This is configuration advice, not proof that a switch happened. Existing
definitions are not modified automatically.

`target.claude_autocompact_tokens` optionally sets a Claude window on managed
and new-each-run tasks. Existing/current targets retain their interactive settings;
the automation override is not applied to them. A managed id pointing at a
pre-existing task also leaves its settings alone; task provenance must match
the automation before a persistent override is written.
Use 100000 for small long-lived scheduled tasks. The supported range is
100000–1000000; [Claude Code's documented minimum](https://code.claude.com/docs/en/model-config#values-and-warnings-for-claude_code_auto_compact_window)
is 100k, so 60–99k is rejected. Explicit automation limits also override the
usual `[1m]` exemption. The automation-created task stores the limit; it applies to
manual continuations of that same managed task too. Clearing it on the automation
restores the global preference on its next run. Other interactive tasks and
the global preference stay unchanged (this checkout's built-in default is
200k; a user's configured 300k is preserved).

Bots already select their home model via their conversation configuration.
Separate per-bot model/compaction defaults are deferred: they need coordinated
bot mutation, harness-switch and settings UI changes. A future bot-level default
could copy into the new home's agent params on creation/switch, with explicit
per-automation values taking precedence. No bot configuration is migrated here.

## Shell pre-checks

A conditional prompt may include `task.precheck`:

```json
{"command": "./scripts/check-needs-action.sh", "timeout_seconds": 30}
```

The command runs under `/bin/sh -c` in the resolved workspace before task creation
or any model call. Exit 0 with **empty stdout** (not just whitespace) records
terminal `skipped_precheck`, creates no task and calls no model. Stderr alone
does not defeat that condition. Other exits, output, timeout or spawn errors
continue to the agent with exit status and bounded stdout/stderr evidence.
Each stream retains at most 12k bytes plus a truncation marker. Output is drained
after the cap, and the whole check has a 1–300 second timeout. On macOS/Unix,
its process group is stopped at completion, timeout or shutdown; checks must
not launch background services. Commands inherit the daemon environment.

A shell command is elevated authority regardless of agent permission mode.
The existing `allow_elevated_automations` setting must allow it. All newly created
checks start paused with `precheck_approved: false`; agents cannot approve,
resume or manually run them. In the UI, open the definition, inspect its
command, timeout and resolved workspace, then use the explicit **Approve pre-check**
button after saving. `automation.approve_precheck` requires the displayed hash
and exact definition revision and never retries stale approvals. Resume and generic
toggles cannot approve a pending command. Task/target edits revoke approval for
all callers. Pre-checks cannot be combined with `run_as_bot`, whose workspace is dynamic. Even already-queued runs recheck approval and the
elevated setting before executing. Disabling elevated automations stops shell
pre-checks; it does not rewrite their saved definitions. Existing non-shell
permission-mode behavior remains as before.

Extension-owned schedules cannot add shell pre-checks: their public host
contract does not grant unattended shell execution. Do not put credentials in
commands; the definition is visible in the editor and control reads. Use files
or existing environment configuration instead.

The local `/api/control/execute` endpoint trusts the origin header from any local
process. Consequently a local process can submit user-origin approval requests;
this hash/revision check protects what was approved, not against a hostile local
process. This branch does not change that pre-existing trust model. Pre-checks
inherit the daemon's environment and run outside the automation's `sandbox_mode`;
that mode governs the agent turn, not the preceding shell command.

## Legacy managed-thread ownership

At daemon startup, managed targets with a remembered thread id backfill a missing
thread origin to the owning automation. The migration is idempotent and persisted
with restored daemon state. Existing origins are preserved. If any other automation
(managed or existing, including paused definitions) targets that id, the origin is
left unset and a warning is logged. Missing threads are ignored. This restores
model pins and per-automation compaction overrides for dedicated legacy tasks.
Settings → Analytics lists models observed on run threads, differing configured
pins, and sortable recorded token totals. Its task-name action opens the editor.
