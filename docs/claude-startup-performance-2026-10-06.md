# Claude startup performance — 6 October 2026

Commit `1ddb7e85` replaces eager Claude transcript hydration with summary-first
discovery and lazy exact history loading. This completes the startup priority in
[the original performance scan](performance-scan-2026-10-05.md).

## Release measurements

Two generated native-session fixtures each contain 80,000 messages and
156.25 MiB of message text. The many-session fixture has 2,000 sessions with 40
messages each (175.5 MiB JSONL); the long-session fixture has 50 sessions with
1,600 messages each (175.9 MiB JSONL). Messages alternate user/assistant, carry
native IDs/cwd/timestamps, and use explicit titles to exclude title-model calls.

These are medians of three fresh processes per scenario on ARM64 macOS with
48 GiB RAM, Rust 1.98.0, and the repository release profile: optimization level 3,
thin LTO, one codegen unit. Both versions use identical fixture files, the same
measurement harness, fake provider CLIs, and a cleared child environment. Fixture
generation happens outside the measured process. The eager baseline is
`dd1b7c1f` with only the measurement harness and `CLAUDE_CONFIG_DIR` resolver
backported; the optimized artifact matches `1ddb7e85`.

| Metric | 2,000 sessions: eager → lazy | 50 long sessions: eager → lazy |
| --- | --- | --- |
| Completed workspace startup | 677.7 → 242.2 ms | 571.5 → 79.5 ms |
| Startup process CPU, user + system | 652.5 → 218.6 ms (**67% lower**) | 545.3 → 58.2 ms (**89% lower**) |
| Peak process RSS at startup | 252.7 → 38.1 MiB (**85% lower**) | 237.8 → 17.7 MiB (**93% lower**) |
| Retained transcript items at startup | 80,000 → 0 | 80,000 → 0 |
| First selected-thread detail | 0.064 → 0.430 ms | 0.693 → 13.090 ms |
| Items retained after that detail | 80,000 → 40 | 80,000 → 1,600 |

All expected sessions and selected-thread item counts were asserted. The lazy
default run retains only 80 KiB of selected message text; the long-session run
retains 3.125 MiB. Full native history has moved to the first open or admission,
which explains the extra detail time.

CPU includes every daemon thread and excludes fake CLI child processes. RSS is
the process lifetime high-water mark, rather than an exact heap measurement.
Filesystem caches were warm. Concurrent host work caused wall-clock outliers:
many-session startup ranges were 614–1,504 ms eager and 239–1,242 ms lazy;
long-session ranges were 567–740 ms eager and 77–172 ms lazy. Outliers remain in
the samples. These measurements establish daemon startup costs with synthetic
histories; installed desktop launch and physical-device UI latency still need
separate profiling.

[All twelve samples](claude-startup-measurements-2026-10-06.json) include CPU,
RSS, startup/detail times, source bytes, and retention counts.

## Loading behavior and race protection

Discovery reads at most a 1 MiB head, 256 KiB tail, and one boundary byte per
large native file. Thin JSON parsing skips tool/image payloads and decodes
opening/latest message candidates. A 1,024-message regression decodes only two
message payloads; other regressions skip a 16 MiB middle tool record and recover
ownership metadata after a 16 MiB opening user record.

Thread detail, stored-item lookup, manual title suggestions, sends, interrupted
resumes, queued dispatch, and compaction share a thread-owned hydration gate.
Admission holds it through provider startup and loads history before marking
Running or appending the prompt. Startup placeholders acquire pending history
state through this same path. Missing/mismatched sources fail before admission.

Exact hydration reads a fixed file-length snapshot off the async runtime and
validates native session ID and cwd. Installation rechecks thread/state identity,
turn state, and empty accumulators; live messages win over late reads. Indexes
and file-backed images are restored without advancing unread activity. Saved
titles, attention, queue, interruption, and variant state remain authoritative.
Valid empty histories have explicit loaded state. Session reset and failed fresh
spawn retire history state atomically. Reconnect preserves active gates/turns,
but invalidates idle history when the native file size or mtime changes.

Bounded discovery can miss titles or opening ownership buried outside both
windows. Exact hydration enriches observable threads; persisted threads retain
an exact source path and fail closed if it cannot be validated. A previously
unknown session without ownership metadata in either window can be omitted from
discovery. Already-opened managed transcripts are retained; eviction of those
histories is a separate optimization. The existing auxiliary parsed-file cache
remains bounded by its 32 MiB source-byte estimate and 256-entry limit.

## Reproduction and validation

Use separate fixture directories because an existing fixture manifest is reused:

```sh
FALCONDECK_STARTUP_FIXTURE_DIR=/tmp/fd-startup-default \
cargo test --release -p falcondeck-daemon --lib \
  app::claude_startup_measurement::measure_synthetic_claude_startup \
  -- --ignored --exact --nocapture --test-threads=1

FALCONDECK_STARTUP_FIXTURE_DIR=/tmp/fd-startup-long \
FALCONDECK_STARTUP_SESSIONS=50 FALCONDECK_STARTUP_MESSAGES=1600 \
cargo test --release -p falcondeck-daemon --lib \
  app::claude_startup_measurement::measure_synthetic_claude_startup \
  -- --ignored --exact --nocapture --test-threads=1
```

`cargo check -p falcondeck-daemon` passed. The final
`cargo test -p falcondeck-daemon --lib --quiet` run passed **1,198 tests**, with four
ignored. Focused coverage includes 54 Claude parser/stream tests, 15 hydration
and admission tests, eight reconnect tests, and the imported interrupted-summary
merge regression. The large measurement is opt-in rather than a timing assertion
in normal unit tests.

`.agents/skills/autoreview/scripts/autoreview --engine codex --mode local` passed
with no actionable P0 findings. It reviewed an isolated copy containing only
these changes; every reviewed source matched the committed file byte-for-byte.
No packaged app or production service was deployed.
