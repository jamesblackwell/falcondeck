# Claude transcript parity audit

Audited against main `5b98f932`, 5 November 2026. Local-only structural inspection
of the 100 most recently modified Claude JSONL files, including 1,472 subagent
records; no private transcript quotations or session identifiers are included.
Compared provider records with native hydration, live monitor, daemon projection,
client normalization, presentation grouping, desktop/web and Expo renderers.
The sample contained 41 Agent calls, 13,241 thinking blocks, Bash/read/edit/search
results, asynchronous tasks, hook notices, retries and compaction boundaries.
These are sample counts, not assertions that every CLI feature occurred.

A separate synthetic CLI 2.1.316 smoke ran in an empty temporary directory with
customizations/MCP disabled and no session persistence. It completed one Bash
call and a final response successfully (two turns). Its input contained no local
session content. Interactive CLI chrome was not replayed as a TTY recording;
CLI visibility below distinguishes provider evidence from terminal-only controls.

| CLI / native evidence | FalconDeck before | This branch / deliberate policy |
| --- | --- | --- |
| Agent description and delegated prompt | Short parent title; arguments discarded | Parent retains its own title, full description/prompt in expanded arguments |
| Child commands and descriptions | Last 24 start titles, often just Bash; duplicate echoes; no results | Ordered calls deduped by provider id; real command summary and status; expandable full arguments/output; no 24-call eviction |
| Child failures and final report | Child result ignored; report replaced activity | Results and report retained; unresolved children settle on interruption, and later-turn background completion merges previous evidence |
| Native child history | Only parent JSONL hydrated | Read matching sibling files using result agentId or sidecar toolUseId, including unfinished parents. Missing files/identity cannot be fabricated |
| Parallel calls and text in one assistant record | Only first tool extracted; prose could consume the record | Preserve every tool block and assistant prose |
| Bash full command/description | Title shortened; input discarded | Lossless arguments, compact command row; output/report first when expanded |
| Bash stdout/stderr | Flattened together without stream identity | Stdout retained, stderr explicitly labelled; nonduplicated result metadata also inspectable |
| Exit, duration, background task ids/output paths | Mostly discarded metadata | Keep reported background ids/paths and rare explicit values without empty UI. Review sample found zero exit fields in 10,843 Bash results and zero durationMs fields in 1,880; do not imply routine exit/duration coverage |
| Provider-persisted large output | Provider path could be lost when flattening | Path/size and provider truncation notices retained; arbitrary result paths are deliberately not auto-read. This does not recover bytes Claude itself omitted from JSONL |
| File edits/diffs | Input absent; unrecognized result object could disappear | Old/new arguments and provider result retained, structuredPatch hunks rendered as a diff; paths and counts inspectable |
| Reads, searches, counts, paths | Compact title plus selected output fields; input/counts lost | Full arguments and nonduplicated result metadata retained. Explicit read-only hiding preference remains honored |
| Thinking | Main-thread content retained; display preference may collapse/group | Retained; unchanged preference. No hidden thinking is invented when provider does not emit it |
| Assistant text between tools | Usually per-message prose; mixed records could lose tools | Prose retained separately in order; mixed records retain tools too. No inferred progress phase |
| Todos / plans | Tool row without input | Full TodoWrite/plan payload visible in arguments; existing plan-approval flow unchanged |
| Hook output | Bare lifecycle chatter filtered; native system/attachment records skipped | Hook response output, errors/context and selected user-facing hook attachments become receipts; silent successful bookkeeping remains omitted |
| Denials, errors, retries | Failed tools shown, retry system metadata often skipped in history | Tool failure/output retained, retry attempt/delay/error receipts restored. Existing approval receipts unchanged |
| Compaction | Live lifecycle supported; native boundaries skipped | Native boundaries restored as first-class compaction receipts |
| Slash commands / native command XML | Bookkeeping wrappers omitted | Deliberately unchanged: terminal-local commands/control envelopes are not ordinary user prose. Actual user prompts and existing compaction/plan actions remain separate |
| Token / cost lines | Usage accounted outside transcript; native cost-state ignored as prose | Existing usage surface retained; no duplicate per-token transcript rows. Agent result token/duration metadata remains inspectable |
| Default tool visibility | Collapsed work-session group, including failures | Existing folded behaviour restored. Rich evidence appears inside the fold or expanded mode; no new default per-call rows or auto-opened failures |
| Explicit compact / hide read-only / thinking settings | Can hide details | Deliberately honored; these are explicit presentation preferences, not data deletion |
| Skill bodies and injected system/context plumbing | Suppressed before storage/transport | Deliberately suppressed, including structured Claude result metadata; instructions/catalogues are not useful transcript output |
| Output page cap | Output-only, UTF-8 safe; detail arguments bypassed cap | Combined output/detail budget; explicit original-byte marker; full item on demand, including arguments-only truncation |
| Claude MCP arguments | Each string silently cut at 4,000 chars; arrays unbounded | Lossless source arguments; aggregate detail page budget. Existing MCP labels retained |
| Render cap | Line/character preview, full copy | Unchanged deliberate performance cap, explicit notice and complete copy available |
| Internal API snapshots, queue state, request blobs | Filtered | Deliberately filtered: duplicate/internal model transport, not terminal transcript evidence |

Screenshots use synthetic data only. Before uses the committed `5b98f932`
renderer and the reported lossy item shape; after uses this branch's renderer
with preserved parent and child evidence. They demonstrate rendering, not a
private session or a running installed app.

The before/after PNGs are delivered as separate local artifacts in the handoff;
the review helper refuses binary changes, so they are not part of the code commit.

Scope: Claude first. Aggregate MCP detail projection also protects other providers
using that existing detail variant; no other harness execution changed. The first revision did inadvertently add
Claude detail to handoff/fork model context; this review round excludes that
evidence and restores the model-facing MCP argument cap. Existing native mobile full-item fetching is reused. Swift clients and
older clients ignore the additive dynamic evidence field and keep the ordinary
parent title/report; they do not gain the new child renderer in this branch.

## Initial revision validation

- `cargo test -p falcondeck-daemon --lib claude -- --test-threads=2`:
  157 passed, two existing ignored tests. Includes child rendering data, failure
  results, metadata, mixed/parallel records, native hydration and aggregate paging.
- `cargo test -p falcondeck-daemon --lib tool_output_cap`: one passed (UTF-8 cap).
- `cargo test -p falcondeck-daemon --lib mcp_presentation`: 23 passed.
- `cargo test -p falcondeck-core --test provider_tool_details`: four passed.
- `npm run test -w @falcondeck/client-core`: 810 passed.
- `npm run test -w @falcondeck/chat-ui`: 213 passed.
- Mobile focused suites (`ClaudeToolEvidence`, `ProviderToolBlock`,
  `thread-item-loader`): 37 passed, including arguments-only full-item recovery.
- Client-core and mobile `npm run typecheck`: passed.
- Chat-ui `npm run typecheck`: three existing errors reproduced identically on
  main: unsupported `exact` option in `bot-sidebar.test.tsx:634`, and HTMLElement
  `setSelectionRange` typing in `prompt-input.test.tsx:49,75`. No new errors.
- Live CLI 2.1.316 synthetic Bash smoke: success, one call and final response.
- `.agents/skills/autoreview/scripts/autoreview --mode local`: clean at the
  helper's default P0 threshold, after the final nested-skill suppression fix.
  Initial preflights refused binary screenshots; those were moved outside the
  patch, and every code/documentation file was reviewed. No findings accepted.
- `git diff --check`: passed. No merge, deploy or installed-app restart.

## Independent review corrections

All structural/native-session checks in this round stay local. Reports contain
aggregate sizes/counts and synthetic regression fixtures only.

| Finding | Correction |
| --- | --- |
| Quadratic live evidence transfer | Central emit projects Claude and MCP tool replacements to 2 KiB; full tree remains daemon-local; test sums bytes over increasing child counts |
| New evidence in handoff/fork | Explicit Claude namespace exclusion plus tests for both prompts; MCP model argument strings capped at 4,000 characters |
| Empty stop-hook rows | Empty arrays/objects rejected; legacy empty receipts excluded by model thread reads |
| Default fold regression | Restored the existing collapsed fold, including failed calls; richer content stays inside it |
| Duplicated result bodies | Strip stdout/stderr/content/originalFile, repeated inputs and image base64 before retaining result metadata; preserve Read counts/paths, dimensions and patch hunks. Image bytes stay in image items, not a duplicate JSON text output |
| Oversized remote item RPC | 512 KiB serialized limit; terminal too-large state directs the reader to the Mac; no automatic retry loop |
| Restart/interrupt/later-turn lifecycle | Sidecar toolUseId association, nested settlement, and previous-evidence merge at item upsert |
| Bash skill-body leak | Full explicit command checked, in addition to file/path arguments; duplicate stdout is not stored in result metadata |
| Legacy clients | Retain a bounded textual activity log in parent output |
| Snake-case result | stdout/stderr extraction accepts toolUseResult and tool_use_result |
| Exit/duration claims | Corrected the table with observed zero-coverage counts; no reserved empty slots |
| Visuals | Claude Agent/Task labels use prose styling; JSON argument text inherits readable foreground instead of light-theme token colors on dark surfaces |

There is no general secret redaction. Before this round, live tool items reached
mobile memory untrimmed; MMKV only bounded the serialized history suffix to 64 KiB
and encrypted it with the pairing data key. This round caps new Claude/MCP events
before they reach that store. Full details explicitly fetched for inspection can
still include sensitive content, and fields within a cached suffix are not
redacted. Handoff/fork omit the new Claude evidence; model thread reads never
serialize that structured detail.

Heavy validation follows the requested London :30–:59 window, at nice 10, with
Cargo limited to four jobs and the existing shared target directory.

## Follow-up validation

- All 51 core unit tests passed. Daemon unit run: 1,845 passed, eight ignored.
  ACP (8), control API (10), control MCP (8), scheduler (8) integrations passed.
  The full Rust command ended on `http_api::connect_workspace_bootstraps_codex_when_available`
  timing out during workspace bootstrap; its other 11 tests passed. Serial retries
  of that test and the terminal suite exceeded a 90-second bound. Startup resume
  (2), Unreal ACP (1) and workspace reconnect (4, one ignored) passed serially.
  The scheduler eventually completed; it was not terminated.
- Client-core full run: 815 passed; final focused export/labels/client/transcript
  run: 60 passed. Chat-ui final full run: 215 passed.
- Mobile final full run: 1,426 passed across 152 files. Two initial timing failures
  passed on focused rerun and on the full rerun with two workers and 15-second
  per-test timeout.
- Desktop full run: 1,531 passed, five failed, one skipped. Failures: three
  App.activity view transitions and two RemotePairingPopover expectations.
  These areas have reported base failures; no unrelated fixes were made.
  CommandPalette passed in this run.
- Client-core, desktop, remote-web and mobile typechecks passed. Chat-ui still
  reports the same three pre-existing test typing errors described above.
- Local autoreview, default P0 threshold: clean, including event/RPC boundaries,
  model exports, lifecycle and on-demand loader. `git diff --check` passed.
- Synthetic final screenshots in both themes verify friendly Agent labels and
  readable Arguments text: measured contrast 10.88:1 dark, 10.57:1 light.

Desktop/web now fetch full tool details on expansion, through two bounded transfer
slots. An open running parent refreshes when it settles or on explicit refresh,
not on every child event. Remote detail requests carry the preview budget;
Mac-local full-item loading remains available. No merge, deploy or restart.

Fixed-copy benchmark (same native parent and sibling files, three runs each):

| Version | Hydrated item JSON | Median hydration |
| --- | ---: | ---: |
| Base `5b98f932` | 15,218,750 bytes (14.51 MiB) | 3,093 ms |
| Corrected branch | 18,949,534 bytes (18.07 MiB) | 3,624 ms |

The corrected history is 24.5% larger and takes 17.2% longer than base because it
now retains child arguments/results and other previously discarded evidence.
The first corrected implementation on this fixed copy was 88,357,901 bytes;
removing duplicate image bodies brought that down by 78.6%. These are serialized
item sizes and wall-clock parse times, not process RSS. The private fixed copy
and all path pointers are removed after measurement.

Final focused Rust validation after lifecycle/image fixes: 162 Claude tests
passed, three ignored; paging and linear event-byte regressions each passed.

The final 17:30-window check passed the explicit empty-hook item expansion
regression. Chat-ui was rerun after the loader freshness adjustment: all 215
passed. A serial App.activity comparison used isolated base packages and shared
third-party dependencies: base and branch both produced the same two failures
(Plugins and Cloud tasks), with ten passes. The extra settings failure seen in
the full desktop run passed on both focused runs.
