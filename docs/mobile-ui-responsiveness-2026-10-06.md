# Mobile interaction responsiveness — 6 October 2026

This pass targets opening the sidebar, switching tasks and sending messages.
The causes were reproduced in production helpers/hooks with synthetic data,
then fixed without changing daemon RPC contracts or native history ownership.

## Sidebar

`SidebarView` sorted every project's threads before `buildSidebarRows` sorted
the same threads again. That extra pass also replaced every thread-array
identity, preventing reuse of project calculations. Selection and collapse
rebuilt partitions, attention totals and sorting across the whole inventory.

Rows now own sorting. A weak cache keyed by immutable project thread arrays
reuses partitions, attention totals, per-mode orders and selected-row indexes.
It retains at most the three supported sort modes per array; replacing a
project's threads invalidates that project's derived data. Drawer selection
callbacks read current selection at invocation, so changing selection does not
replace the callbacks passed to every memoized task row.

The 72-project/2,710-task fixture previously scanned 144 projects across one
selection and one collapse; it now scans zero. Updating one project derives
one project instead of 72. Node p95 row-build time was 0.145 → 0.054 ms;
single-project refresh including the removed duplicate sort was
0.195 → 0.0725 ms. These are helper microbenchmarks, not iPhone frame timings.
Ordering, pins, attention status, filters, paging, selected off-window rows,
collapsed projects and permanent iPad visibility retain regression coverage.

## Task opening and optimistic messages

Independent selected-task hooks each searched the full task inventory whenever
the store changed, even when React ultimately skipped the render. They now
share one lookup per immutable catalog and workspace/task selection, including
missing selections. The weak cache keeps only the latest selection per catalog.
Paused transcript hooks return their frozen value before any lookup and catch
up from current state when resumed.

With 3,000 summaries and six actual hooks, catalog row reads fall from
54,000 to 3,000 on mount, and from 360,000 to zero across 20 unrelated store
updates. Workspace ownership, catalog replacement, misses and selection
changes invalidate correctly.

The pending first message in a new task previously returned a fresh one-item
array on every render. A 256 KiB optimistic prompt consequently derived its
presentation 21 times across 20 unrelated composer renders. Its array now stays
stable until the item or loaded history changes, reducing that count to one.
Tests cover replacement, clearing, conversation ownership, loaded-history
precedence and pause behavior.

New-task handles, RPC summary results and optimistic insertion/removal also
used to synchronously serialize and encrypt the full session cache. They now
join the existing deferred writer, which reads the latest state and coalesces
changes. The tap/RPC continuation performs zero synchronous full-cache writes.
Pending messages remain excluded from the cache; explicit relay checkpoint
flushes and reset cancellation retain their existing boundaries. Event-driven
persistence and archive behavior are unchanged.

## Sending

Before the fix, `beginSubmission` flushed the pending whole draft collection,
wrote the encrypted in-flight journal and wrote the cleared draft collection
before publishing the cleared composer. Optimistic insertion could then encrypt
the full session cache before the existing paint yield. A real-hook Mac Node
probe with 100 retained 9 KB drafts measured 61 ms for a queued send and 86 ms
for an idle send in that synchronous segment, with three composer writes.

A subsequent matching seven-sample fixture with two warmups measured median
prepaint send work at **56.454 → 0.125 ms** for an idle task and
**54.979 → 0.134 ms** for a queued send. Composer writes before that paint fall
from three to zero, and their ciphertext output from 2,387,020 characters to
zero. The remaining journal/latest-drafts checkpoint takes about 24.2–24.6 ms
after the paint in this Mac Node fixture. This removes the first-feedback
block and roughly halves recovery encryption; it does not move all subsequent
encryption off the JavaScript thread.

The send path now stages the cleared composer and optimistic transcript/queue
item in memory, yields for feedback to paint, then checkpoints recovery before
dispatching either task creation or the turn RPC. It writes the in-flight
journal before one latest draft collection, instead of flushing a superseded
collection too. Other callers retain a synchronous checkpoint API.

Recovery records identify the durable draft collection they superseded using
its encrypted-envelope nonce. This prevents an interrupted journal/draft
checkpoint from restoring a stale debounced prefix beside the submitted text.
Newer typed drafts remain separate and are merged on recovery; legacy journals
retain their existing recovery behavior. Background flushing, concurrent sends,
selection changes, captured new-task settings, failures, session replacement
and key rotation have focused regressions. Cleared sessions cannot be recreated
by a delayed send continuation.

## Validation

Validation uses an isolated checkout based on `48fbf401`, containing only this
pass's changes. Other agents' pending Hermes and shared-client work is excluded.
The full mobile suite passed **1,363 tests across 142 files**, and mobile
typecheck passed. Bundled-JavaScript Release builds of both baseline and
candidate completed. The candidate passed native smoke assertions for opening
the sidebar, switching tasks, displaying a sent message with an empty composer,
and opening a new task with an empty transcript/composer.

Repo review command:
`.agents/skills/autoreview/scripts/autoreview --engine codex --mode local`.
The review result is recorded with the completion handoff.

Timing and operation-count artifacts are
local under `/tmp/falcondeck-sidebar-performance-20261006` and
`/tmp/falcondeck-mobile-send-20261006`; the send timing logs are
`/tmp/falcondeck-send-performance-before.txt` and
`/tmp/falcondeck-send-performance-after.txt`.

The release smoke uses only the existing dedicated CPU Lab simulator and
synthetic demo conversations. It does not pair a device, restart the daemon or
send prompts to a real provider. These checks establish the removed work and
interaction behavior; physical-iPhone release frame/input latency still needs
measurement before claiming an end-to-end speedup.
