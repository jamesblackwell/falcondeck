# Startup thread-search indexing — 6 October 2026

Fixed the repeated empty-file reads identified in the
[installed startup profile](installed-startup-performance-2026-10-06.md).
Search now persists metadata for successful bounded scans without searchable
user excerpts. The JSONL parser also borrows strings and discards irrelevant
fields while validating them, rather than building complete owned JSON values.

## Reproduction and cache behavior

Before the fix, the regression
`unchanged_files_without_user_excerpts_are_not_reread_after_restart` failed:
after saving and reloading the index, one unchanged assistant-only file was
opened again and **3,276,890 bytes** were read. That file contains a synthetic
1 MiB assistant body; overlapping head/tail searches explain the extra reads.
The regression now observes **zero opens and zero source bytes** after reload.

The manual fixture uses 64 such files and compares the same new parser with
and without persisted empty-result metadata, isolating the cache improvement.
In one warm-filesystem debug-build observation:

| Rescan | Transcript opens | Source bytes read | Elapsed time |
| --- | ---: | ---: | ---: |
| Empty metadata absent, matching the old cache | 64 | 209,720,960 | 462.185 ms |
| Persisted empty metadata present | 0 | 0 | 0.470 ms |

The serialized index was 12,139 bytes, containing paths and fingerprints, with
no transcript text. Enumeration and filesystem metadata checks still run.
Elapsed times are illustrative; source-operation counts are the regression
contract. Run the fixture with:

```sh
cargo test -p falcondeck-daemon --lib \
  app::thread_search::cache_tests::measure_large_empty_inventory_rescan \
  -- --exact --ignored --nocapture
```

Empty entries use absolute path, byte length, exact modification timestamp,
and Unix device/inode/ctime. They are admitted only after successful reads and
unchanged descriptor metadata before/after the scan. Read failures remain
retryable; malformed or filtered records can produce successful empty scans.
Appends, truncation, atomic replacement and same-size edits preserving mtime
invalidate the result. Rebuilding from the current inventory prunes deleted,
moved and foreign-root entries. A scan-policy version invalidates negatives
when extraction or window semantics change. Existing positive caches remain
compatible and reusable without a forced transcript reread.

Retention is bounded to 16,384 empty files and an 8 MiB estimate of owned
metadata. Oversized entries bypass retention. The existing excerpt index is
still only a search cache; native agent files remain the history source.

## Parser allocations

The new parser retains only eight recognized field names and borrows unescaped
strings for extraction. Unknown objects/arrays are walked without retention.
A strict discard visitor preserves the former parser's rejection of malformed
numbers, Unicode escapes and excessive nesting. Plain `IgnoredAny` would
incorrectly accept some of those records. Duplicate keys retain their last
value, and nested null content continues to mask top-level fallback content.

Allocation profiling also found plain prompts formatting every harness tag
before taking the existing plain-text shortcut. Moving that shortcut before tag
scans, after handoff/skill handling, removes those transient allocations.

The standalone release benchmark compares the old owned parser and original
cleaner against the final parser and cleaner. It uses production extraction,
harness projection and Codex sanitization with synthetic records. Five process
runs, 20 warmups per fixture, 400 timed iterations for large records and 100,000
for the small prompt; these are median process-CPU means:

| Record | CPU per line, before → after | Allocation calls | Requested bytes |
| --- | ---: | ---: | ---: |
| Assistant, 1 MiB | 79.010 → 62.875 µs | 7 → 2 | 1,049,867 → 384 |
| Tool result, 1 MiB | 78.798 → 64.233 µs | 12 → 4 | 1,050,644 → 704 |
| User prompt with 1 MiB image | 85.385 → 63.933 µs | 146 → 15 | 1,054,026 → 1,041 |
| Codex assistant, 1 MiB | 77.453 → 63.335 µs | 16 → 4 | 1,050,674 → 704 |
| Plain prompt, 74 bytes | 5.745 → 0.377 µs | 139 → 14 | 4,167 → 849 |

The allocator counts alloc/realloc requests, including scratch and cleaning;
these figures are not peak heap or RSS. CPU includes allocator accounting.
Large escaped strings still require decoder scratch and owned decoded text:
the escaped fixture requested approximately 2.75 MB on both paths. Head/tail
windows still overlap on cold scans. No installed startup CPU/RSS improvement
is claimed from these synthetic results.

Local measurement sources, raw results, hashes and commands are retained in
`/tmp/falcondeck-production-parser-bench/README.md`; no native session contents
were used or committed.

## Validation

Regression coverage includes persistent reuse, appended searchable prompts,
old positive indexes, root/path collisions, moves/deletion, truncation,
preserved-mtime edits/replacements, read errors, concurrent edits, metadata
bounds and policy invalidation. Parser tests compare the old extraction with
production cleaning across Claude/Grok/Codex envelopes, duplicate keys,
null/flag behavior, tools, attachments, Unicode, malformed records and injected
harness/service text. Borrowing and large-payload retention are checked directly.

The full daemon library suite passed: **1,250 tests, five ignored** (including
the manual measurement above). Validation used current committed `main` at
`dcb02e35` plus only this patch in a detached checkout and separate Cargo target
directory, excluding other agents' uncommitted changes.
