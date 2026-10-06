# Workspace reconnect performance — 6 October 2026

Code commit: `be627fd4` (Reduce workspace reconnect latency).

The stopped-session dialog disables Continue while its target workspaces remain
Connecting. Provider discovery was on that critical path, and workspace restore
processed one project at a time. The local state contained 72 sidebar workspaces.

A read-only probe against the installed Codex app-server in this repository
measured account/read at 555 ms, model/list at 410 ms, unscoped thread/list at
4,557 ms (779,722 response bytes), subagent thread/list at 6,013 ms, and
skills/list at 86 ms. A second process with a cwd filter returned the workspace
list in 2,742 ms (626,524 bytes); its subagent scan still took 5,936 ms. These
single warm observations identify costly calls, not a controlled speedup.

The fix reconnects at most four workspaces concurrently, retaining interrupted
project priority. After the initialization handshake and skill-root setup,
independent Codex account/model/mode requests overlap. Native workspace listing
now includes cwd, and thread, skill and subagent discovery overlap. Projects
with no saved Codex sessions skip the subagent cleanup scan. Skills use the
existing control-request timeout. Claude startup authentication is coalesced
and cached for 30 seconds by executable and CLAUDE_CONFIG_DIR; explicit metadata
refresh probes again and replaces the cached result. Native history and exact
session verification still govern interrupted continuation.

## Controlled comparison

The same eight-project fixture was run three times on baseline `b0dbd7da` and
optimized `be627fd4`, using rustc 1.98.0 and debug builds on the same Mac. Each
project retains one native Codex session; the last project has an interrupted
turn. A fake app-server handles requests independently and delays account,
model, mode and skill reads by 100 ms, workspace listing by 250 ms, and subagent
listing by 400 ms. A fake Claude auth check takes 120 ms. No real turns are sent.
Timing spans restore_local_state through all eight workspace statuses becoming
Ready and asserts that all eight sessions remain present.

| Sample | Baseline (ms) | Optimized (ms) |
| --- | ---: | ---: |
| 1 | 9,973.707 | 2,232.311 |
| 2 | 9,697.283 | 1,518.020 |
| 3 | 9,641.569 | 1,547.622 |
| Median | 9,697.283 | 1,547.622 |

The median is **6.27× faster**, an 84% reduction. This establishes the benefit
for this controlled I/O fixture, not a measured 6.27× installed-app launch gain.
Real provider service times, machine load and the number of target projects
will affect the result. This task has not rebuilt or restarted the installed app.

Reproduce the optimized measurements with:

```sh
cargo test -p falcondeck-daemon --test workspace_reconnect \
  measure_eight_workspace_reconnect -- --ignored --nocapture
```

For the baseline, copy the same measurement test into an isolated checkout of
`b0dbd7da` and use the same compiler and command. Do not run the new concurrency
regression against the baseline: it intentionally waits for four concurrent
projects and must fail with the old serial queue.

## Validation

The barrier regression proves that exactly four projects reach discovery before
release, the interrupted project belongs to the first batch, and all sessions
survive reconnect. The Codex suite passed 68 tests, including native cwd filtering
and all three metadata requests being admitted before out-of-order responses.
The auth-cache regression passed, checking coalescing, explicit refresh, expiry,
and a different executable. The full daemon library suite on an isolated checkout
of `be627fd4` passed 1,210 tests, with four ignored. The two automatic-resume
integration tests and the workspace-reconnect barrier test also passed. The
controlled timing test is ignored by default and passed when explicitly run.

Required review:
`.agents/skills/autoreview/scripts/autoreview --mode commit --commit be627fd4`
completed cleanly with no accepted/actionable findings (default P0 threshold).
The report-only commit skips autoreview.
