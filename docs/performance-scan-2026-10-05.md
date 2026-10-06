# Performance scan — 5 October 2026

Nine verified fixes cover large session lists, transcript streaming and repair,
sync paging, native history caches, and relay delivery. All changes are committed
on `main`. Packaged apps and the production relay had not been rebuilt or deployed
at the end of this scan. The Mac app was rebuilt and installed in the
[6 October startup follow-up](installed-startup-performance-2026-10-06.md).

| Path | Before | Fixed behavior and regression evidence |
| --- | --- | --- |
| Mobile project sidebar | Selecting the oldest of 10,000 loaded sessions constructed all 10,000 rows, including collapsed cells. | Five normal rows plus one selected row. Show more advances the normal window by ten. |
| Extension session filters | 1,000 sessions with 1,000 projections read 500,500 projection entries. | One projection indexing pass: 1,000 reads. Tests retain extension/view/scope isolation, first duplicate, archived rows, and multiple filters. |
| Shared streaming reducer | Twenty frames on a 1,000-item transcript accessed original item identities 19,982 times while rebuilding maps. | Two accesses in the same fixture. Tail updates bypass the full history index; mixed and non-tail updates retain indexed lookup. |
| Frozen sync pages | Five pages filtered and sorted the same frozen workspace five times. | One lazy order per frozen workspace and sort. Indices are grouped once, future order memory is included in cache admission, and alphabetical keys are computed once per row. |
| Codex history repair | 512 assistant event/response pairs required 262,656 whitespace normalizations and cloned the transcript during deduplication. | At most 1,024 normalizations, indexed timestamp lookup, moved items, and indexed supplemental tool IDs. Tests retain timestamp rounding, repeated text, reordered responses, and native tools. |
| Desktop transcript cache | Every visited transcript remained cached until its session disappeared. | At most 50 entries, with visits updating recency and the selected expanded transcript protected from delayed prefetch completions. Evicted sessions reload from the daemon. |
| Claude parsed-file cache | Unbounded duplicate transcripts remained in a global cache. A 33 MiB transcript was retained twice. | 32 MiB source-byte estimate and 256-file limits, LRU eviction, stale/deleted entry removal, and oversized-file bypass. The original 33 MiB message still hydrates intact. Workspace filtering happens before cloning cached items. |
| Relay queue admission | Full JSON was allocated solely to measure permits, including payloads that could not fit. | Exact bounded counting writer without a payload buffer. A 32-byte budget visits fewer than three sequence elements instead of 100,000; zero budget visits none. Escaping and permit lifetime/rejection tests pass. |
| Relay compact live fanout | Each compact peer cloned a legacy snapshot's ciphertext before replacing it with an invalidation marker. | Borrowed projection copies only routing metadata for compact peers. A mixed-client 3 MiB test preserves update ID, sequence, timestamp, ordinary events, and full legacy replay. |

These are deterministic operation-count, retention, and correctness regressions.
They do not establish physical iPhone rendering latency or installed-app startup
times. The Claude cache budget estimates content using source-file bytes; it is
not an exact heap limit. Large workspaces can reparse more files when reopened.

## Validation

| Command | Result |
| --- | --- |
| `npm test --workspace @falcondeck/client-core` | 676 passed |
| `npm test --workspace falcondeck-desktop` | 1,139 passed; one skipped |
| `npm test --workspace @falcondeck/mobile` | 1,246 passed |
| `npm test --workspace falcondeck-remote-web` | 111 passed |
| Typecheck for each of those four workspaces | Passed |
| `cargo test -p falcondeck-daemon --lib codex::` | 66 passed |
| `cargo test -p falcondeck-daemon --lib claude::` | 46 passed |
| `cargo test -p falcondeck-daemon --lib sync_index::tests` | Four passed |
| `cargo test -p falcondeck-daemon --lib` — final full run | 1,156 passed; three ignored |
| `cargo test -p falcondeck-relay --lib` | 49 passed; two PostgreSQL-dependent tests ignored |
| `cargo test -p falcondeck-relay --test relay_api` | 54 passed; one PostgreSQL-dependent test ignored |

The first full daemon run passed 1,154 tests, ignored three, and found two stale
provider-failure fixtures. Both failures reproduced individually on the starting
commit, `e6e5b4d8`. They assumed an absent Claude runtime would reject a turn, but
existing lazy runtime creation can launch the installed CLI. The fixtures now
explicitly configure nonexistent Claude executables, avoiding developer-machine
dependence and unintended CLI launches. The final full daemon run passed all 1,156
tests with three ignored. Across the four client suites, daemon, and relay unit
and integration suites, 4,431 tests passed. The ignored PostgreSQL tests need a
database-equipped run; no production database test was performed here.

## Review and commits

The repository helper is run per code commit:
`.agents/skills/autoreview/scripts/autoreview --engine codex --mode commit --commit <sha>`.
Its default reporting threshold is P0.

| Commit | Review |
| --- | --- |
| `918eaa59` — bounded UI work and desktop cache | Clean; no accepted/actionable findings |
| `6362fd94` — cached frozen workspace orders | Clean; no accepted/actionable findings |
| `3a1731a6` — native history repair and Claude cache | Clean; no accepted/actionable findings |
| `971fcffd` — relay allocation reductions | Clean; no accepted/actionable findings |
| `8e013eb9` — deterministic Claude failure fixtures | Clean; no accepted/actionable findings |

One native-history review was invalidated by concurrent workspace edits. The
successful rerun used a detached review checkout of the same commit. Existing
mobile input and snapshot-status changes were excluded from every commit here.
The report-only commit skips autoreview; every code commit has a clean review.

## Remaining priorities

**Claude startup hydration was completed on 6 October** in `1ddb7e85`.
The original local inventory found 143 Claude JSONL files totaling 448.7 MiB,
including two larger than 32 MiB. Summary-first discovery and shared lazy
hydration/turn admission now remove eager transcript retention. See the
[follow-up measurements and regressions](claude-startup-performance-2026-10-06.md).

**Installed Mac startup profiling was completed on 6 October** with 72 native
workspaces. `372f8da9` adds shared Claude metadata caching and stream-first desktop
bootstrap. See the [installed measurements](installed-startup-performance-2026-10-06.md)
for observed CPU/memory, validation and the remaining search-index/catalog work.

1. **Desktop/web casual Chats lists.** The shared sidebar maps every casual
   session into a complex row; ordinary project lists already use bounded
   windows. Confirm the actual casual-session count and profile React commits
   before choosing paging or virtualization.
2. **Further installed-build measurements.** Measure warm reconnect, typing
   during catch-up, memory after browsing many sessions, and physical iPhone
   startup. Use the throttled/mixed-version scenarios in
   `docs/remote-sync-qa.md`.

Codex startup already obtains summaries through native `thread/list` and leaves
items empty. Its background search index uses cached, bounded head/tail scans and
skips files over 512 MiB. The relay already has independent socket pumps,
byte/count limits, chunk credits, compact invalidations, bounded replay, granular
Postgres writes, and retention pruning before startup load.
