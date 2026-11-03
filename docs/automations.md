# Automation cost controls

The daemon validates schedules deterministically. MCP creates and updates must
repeat no more often than every 30 minutes. For reused tasks (managed, existing,
or current), a known cache TTL also rejects a minimum gap in `(TTL − 5 minutes,
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

Minimum-gap checks simulate fourteen days from the first future occurrence,
using the real scheduler and timezone. Sparse schedules with fewer than two
occurrences in that window have no gap-based advice. The editor's 50-minute
cron conversion is offered only for contiguous hours without month/day-of-month
constraints, preserves weekdays and timezone, and uses the selected hours as a
window (for `8-17`, 08:00 inclusive to 18:00 exclusive). Other cron schedules
can use a fresh task without changing their calendar constraints.

Existing saved automations are never migrated or rewritten by these controls.
