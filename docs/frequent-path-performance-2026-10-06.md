# Frequent-path performance — 6 October 2026

Four further fixes target repeated streaming and compact-sync work. They
preserve the existing event/RPC contracts and native history ownership.

| Path and synthetic fixture | Before | After |
| --- | --- | --- |
| Rust coalescer, 10,000 contiguous 64-byte deltas | 99,995 allocations requesting 9.61 GB; 48.8 ms | 25 allocations requesting 2.10 MB; 0.45 ms |
| Rust coalescer, 100 contiguous 64-byte deltas | 995 allocations requesting 1.06 MB; 39 µs | 18 allocations requesting 18.8 KB; 4 µs |
| Compact workspace projection, 72 workspaces with repeated skills | 53,281 allocations requesting 11,680,900 bytes | 1,081 allocations requesting 94,660 bytes |
| Freezing 2,000 already-projected compact rows | 14,010 allocations requesting 4,687,558 bytes for a second projection | Ownership transfer; no second projection allocations |
| Mobile open fence, 100 appends after 1,000 code lines | 4,524,850 characters reparsed; Node p95 3.377 ms | No canonical-parser input during those appends; p95 0.046 ms |

Allocation figures count requested alloc/realloc bytes, not retained memory or
RSS. Coalescer figures are nine-run release medians with input creation excluded;
catalog projection is one optimized harness observation. Markdown timings are
Mac Node measurements excluding rendering, rather than iPhone latency. No app
installation, production deployment or installed-process profiling occurred in
this pass.

## Rust streaming and sync fixes

The old coalescer formatted the complete accumulated prefix and cloned an
envelope for every contiguous delta. Its copy cost grew quadratically within a
flush interval. The new coalescer starts with the shared broadcast envelope,
then creates a private growing text buffer on the first merge. Subsequent
deltas append into that buffer. Only draining creates a new cached output
envelope. Other consumers and their cached JSON remain unchanged. Boxed merged
envelopes keep each pending event at 16 bytes despite the large event enum.

Regressions cover amortized capacity growth, Unicode/UTF-16 offsets, sequence
and timestamp metadata, distinct stream identities, gaps/overlaps, missing
offsets, replacements, terminal/unrelated flushes, consumer isolation and
unchanged cached-envelope reuse. Existing bridge coalescer tests still pass.

Compact snapshot construction previously cloned every workspace/agent skill
catalog, then immediately cleared those fields. The projection now skips those
copies, including newly reconciled provider entries. Full snapshot fields and
the stored catalogs remain intact. Tests compare complete projected summaries
with the old clone-and-clear result, including models, loading state and other
metadata.

The compact snapshot builder already filters and projects its thread rows.
Freezing the sync index previously projected them again. It now takes the owned
row buffer directly. A failing regression reproduced the second copy before
the fix and now checks preserved buffer/string ownership and identical JSON.
Initial rows, counts, selected/hidden workspace behavior, frozen paging orders,
cache admission and expiration retain their existing tests.

## Client parsing and Rust placement

Mobile Markdown parsing already reused settled prose, but reparsed complete
fences while code streamed. An append path now reuses an unclosed top-level
literal code block and updates its text and positions. Possible closing fences,
containers, indentation, normalization-sensitive characters, replacements and
completed messages use the canonical parser. Character-by-character AST parity
tests cover those boundaries, escaped info strings, Unicode and line endings.
Prior ASTs remain immutable.

Moving work to Rust helps when it is independent of client presentation and can
be done once for every consumer: provider normalization, sync projection,
sorting/paging, payload sizing and stream coalescing already fit that boundary.
The measured fixes remove duplicated work in those Rust owners rather than
making each client compensate for it.

Markdown, folding, selection and preference-dependent layout should remain
client-owned for now. Sending fresh Markdown ASTs or complete display blocks
from Rust would add serialization, encrypted transfer and reconciliation for
mobile/web, while the measured client algorithm can be improved locally. The
current client ingress also normalizes event envelopes once and reuses them;
a blanket rewrite would not remove that work without preserving mixed-version
compatibility. Shared catalog preparation/deduplication is a stronger future
Rust candidate, especially for legacy/full snapshot clients.

## Validation and remaining candidates

Validation used committed `main` at `f98be613` plus only these changes in an
isolated checkout, excluding other agents' ongoing edits:

- Daemon library: **1,271 passed, five ignored**.
- Mobile full suite: **1,298 passed**; mobile typecheck passed.
- Focused mobile parser/renderer: **69 passed**.
- Production daemon check: `cargo check -p falcondeck-daemon`.
- Repo review command:
  `.agents/skills/autoreview/scripts/autoreview --engine codex --mode local`.

The next measured client issue is long streaming lists: 100 appends after 1,000
lines reparsed 6.03 MB with roughly 35–38 ms Node p95. List spread, nested
containers and partial markers require an item-aware append strategy. Settled
conversation projection also rebuilds historical wrappers before reusing their
identities; the 5,000-message audit measured 3.11 ms p95 for derivation/reuse,
but the usual 150-item tail was 0.17 ms.

Rust relay fanout still copies ordinary large ciphertext updates for retention
and each peer. A 3 MiB/two-peer fixture requested 9 MiB for those copies before
encoding. Sharing retained update ownership needs a dedicated change that
preserves replay persistence, queue permits, compact/legacy projection and
revocation. Full snapshot catalog repetition remains as identified in the
[installed profile](installed-startup-performance-2026-10-06.md).

Local reproduction sources/results remain under
`/tmp/falcondeck-coalescer-measurement`, `/tmp/falcondeck-hotpaths-20261006`,
`/tmp/falcondeck-rust-sync-audit`, and `/tmp/falcondeck-markdown-after.mjs`.
All fixtures are synthetic; no native transcript data was committed.
