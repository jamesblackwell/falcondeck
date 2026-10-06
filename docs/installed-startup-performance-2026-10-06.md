# Installed FalconDeck startup — 6 October 2026

Rebuilt and installed the summary-first Claude implementation, profiled it with
the native session inventory, then fixed repeated Claude metadata discovery and
the desktop's duplicate startup snapshot. Code is committed on `main` in
`372f8da9`. The final signed installation passed the documented workflow's daemon
health check, with 72 ready workspaces and 2,710 thread summaries.

## Build and measurement

Both builds used `make desktop-install`. A detached build checkout at
`88603303` excluded other agents' uncommitted work; the second build added only
the tested performance patch. Local installation uses the Makefile's release
overrides: incremental compilation, no LTO, and 16 codegen units. These are
installed local-build measurements, separate from the earlier fully optimized
[synthetic Claude measurements](claude-startup-performance-2026-10-06.md).

The clean checkout initially lacked the ignored ARM64 Deno sidecar. Preparation
used `node scripts/prepare-extension-runtime.mjs --target=aarch64-apple-darwin`
and the corresponding computer-use runtime preparation. Installation then used
`TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin make desktop-install`. The final
installed executable matches the built bundle's SHA256, and
`codesign --verify --deep --strict /Applications/FalconDeck.app` passes.

The [read-only sampler](../scripts/desktop-startup-profile.py) records kernel
user/system CPU time, RSS and physical footprint every 200 ms. It finds the exact
installed main executable without arguments, excluding MCP helpers. WebKit
processes must identify that main PID as their responsible process; ordinary
parent PID is insufficient because those processes are launched by XPC.

The daemon is embedded in the desktop host. Its CPU and memory cannot be split
from the shell in these measurements. UI figures sum verified WebContent
processes; GPU and network processes are recorded separately. Harness children,
other MCP processes and unrelated applications are excluded. CPU is elapsed
processor time across all threads, not wall-clock time. A one-second CPU fixture
verified the Mach tick conversion against Python process CPU time within 0.007%.

The first attached sampler stopped when FalconDeck closed. The added `--detach`
option runs one finite capture in its own process session, surviving app restarts.
It installs no service and schedules no restart. A complete baseline capture and
the optimized installation capture both observed the new main PID within 51 ms
of launch. Optional three-second native stack samples ran in both captures.

Example capture, armed before the separately authorized restart/install:

```sh
python3 scripts/desktop-startup-profile.py --detach --duration 480 \
  --stack-samples --output /tmp/falcondeck-startup.json \
  --markers /tmp/falcondeck-startup.markers.jsonl
make desktop-install
```

The baseline warm-restart command returned a LaunchServices `open -g` error
`-600`. A later launch produced the captured baseline PID. All timing below uses
the kernel's actual process launch time, excluding that gap. The final
`make desktop-install` completed normally and reported a healthy daemon.

## Observed costs

The baseline inventory contained 72 workspaces and 2,703 persisted/native thread
summaries. Other work continued during the measurements; the final count was
2,710, including 856 Claude summaries and 235 archived threads. Native files and
summaries are different inventories: a persisted summary can precede discovery
or remain after its transcript file is unavailable.

| First 30 seconds after host launch | Lazy-history baseline | Additional fixes |
| --- | ---: | ---: |
| Host CPU, including embedded daemon | 6.956 s | 5.994 s |
| UI WebContent CPU | 2.627 s | 1.889 s |
| Host peak RSS | 272.5 MiB | 281.2 MiB |
| UI WebContent peak RSS | 598.5 MiB | 377.1 MiB |
| Concurrent verified-process peak RSS, including GPU/network | 1,179.6 MiB | 914.8 MiB |
| Concurrent verified-process peak physical footprint | 837.1 MiB | 744.2 MiB |

HTTP health first succeeded at 1.512 seconds in the baseline and 2.690 seconds
after the optimized install. This does **not** establish a startup-latency
improvement. Post-capture native UI checks showed a connected app, populated
sidebar and selected conversation, with no restoration overlay. The manual
checks occurred after thread resumption and do not measure first interactive
paint.

The [numeric record](installed-startup-measurements-2026-10-06.json) also includes
10- and 60-second windows, physical footprint and 60–90-second medians. The
baseline had substantial additional work after 30 seconds: host CPU reached
11.431 seconds and UI CPU 7.649 seconds by 60 seconds; the optimized observation
was 6.736 and 3.638 seconds. Those later windows include active session traffic.

These are single live launches, with warm filesystem caches and changing user
activity. Selected conversations and window geometry differed at later visual
checks. The baseline was a warm restart; the optimized binary was newly signed.
Consequently, the observations are not controlled causal benchmarks or quiet
idle-memory measurements. Sampled peaks can miss short spikes, and process sums
can double-count shared pages. Deterministic regressions below establish removal
of the duplicate work independently of this noise.

## Verified fixes

### Repeated Claude fallback discovery

Only nine of the 72 workspaces had a matching encoded Claude project directory.
The other 63 invoked the global fallback over the same 121 eligible native files.
The bounded metadata windows totaled approximately 84.4 MiB per fallback:
roughly 5.2 GiB of repeated reads/parsing during a full reconnect pass.

`claude/history.rs` now shares metadata-only results across workspaces. Its cache
retains at most 4,096 entries and an 8 MiB estimate of owned metadata, with LRU
eviction and oversized-entry bypass. Foreign cwd checks happen before copying
summaries. Cache entries include negative parse results, but never conversation
items. Root/path identity, length, modification time, and Unix inode/ctime detect
changes; enumeration still observes added, moved and deleted files. Exact history
hydration and its existing admission/live-message protections remain separate.

A failing fixture reproduced eight parses of one unchanged file for eight
foreign workspaces. The same fixture now parses it once, and matching-workspace
discovery reads no further source bytes. Additional tests cover concurrent cold
discovery, malformed files, root isolation, new/moved/deleted files, atomic
replacements and in-place edits preserving size/mtime, entry eviction and byte
budget eviction.

### Duplicate desktop bootstrap snapshot

The desktop fetched an HTTP snapshot before connecting to the event socket,
which already starts with an authoritative snapshot. The installed full snapshot
was approximately 9.95 MB, so launch and reconnect transferred and processed
approximately 19.9 MB before ordinary live updates.

The desktop now adopts the initial stream snapshot directly. The daemon
subscribes before constructing that snapshot, preserving event coverage. Saved
selection/detail prefetch waits for the snapshot. An open socket that never
delivers it times out; abandoned sockets and cancelled frame/timer batches cannot
apply late callbacks. The existing HTTP watchdog still repairs quiet live-thread
status when needed.

The bootstrap regression initially failed because the HTTP snapshot was called.
It now proves zero startup HTTP snapshot calls, readiness after the stream seed,
and deferred selected-thread hydration. Reconnect tests cover missing seeds,
late socket callbacks and cancelled batches; existing watchdog and restoration
tests still pass.

## Validation and review

Checks ran against the isolated baseline plus these changes, excluding concurrent
in-progress harness/client changes:

- Claude-focused Rust tests: **62 passed**.
- Full daemon library: **1,206 passed, four ignored**.
- Desktop connection hook: **17 passed**; desktop typecheck passed.
- Sampler: finite detached capture completed; five verified processes observed;
  CPU conversion fixture passed.
- Repo autoreview:
  `.agents/skills/autoreview/scripts/autoreview --engine codex --mode local`.
  **Clean; no accepted/actionable findings at the default P0 threshold.** The
  isolated review copy matched every committed file; tested Rust/UI copies also
  matched byte for byte.
- Final install: signed bundle verified, installed/built executable hashes match,
  `/api/health` is healthy, all 72 workspaces ready, `restore_phase` is `ready`.

## Remaining startup work

Native stack samples in both builds include `thread_search::rescan`, user-message
JSON parsing, snapshot projection and Claude discovery. Stack observation counts
include blocked threads and overlapping frames; they are attribution evidence,
not CPU percentages.

The next strongest search-index issue is unchanged files yielding no user
excerpt. `thread_search::rescan_roots` caches only successful excerpts, so empty,
tool-only and metadata-only files are reopened on subsequent scans/startups. The
metadata audit found approximately 703 MiB across eligible unchanged paths absent
from the existing index. Its parser also allocates full JSON values for discarded
tool/image records and retries overlapping tail windows. Cache fingerprints for
successful empty scans and preserve invalidation when a prompt is appended;
verify source-read counts before optimizing the parser.

Workspace catalogs accounted for approximately 6.73 MB of the 9.62 MB compact
snapshot: agent catalogs/skills about 4.79 MB, workspace skills 1.46 MB, models
0.43 MB. Workspace reconnects still emit full snapshots, so catalog duplication
remains after removal of the initial duplicate request. Profile those emissions
before choosing catalog filtering or incremental workspace updates. Per-workspace
auth CLI probes also merit separate child-process measurement; this sampler's
CPU totals deliberately exclude them.

This inventory had only 12 active casual chats. Broad casual-list virtualization
ranks below the measured search/catalog work for this installation.
