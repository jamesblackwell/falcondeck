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
| Child failures and final report | Child result ignored; report replaced the activity log | Failed/completed states and results retained alongside parent report; background completion preserves detail |
| Native child history | Only parent JSONL hydrated | Read the provider's matching sibling subagent JSONL by validated agent id; missing files cannot be reconstructed |
| Parallel calls and text in one assistant record | Only first tool extracted; prose could consume the record | Preserve every tool block and assistant prose |
| Bash full command/description | Title shortened; input discarded | Lossless arguments, compact command row; output/report first when expanded |
| Bash stdout/stderr | Flattened together without stream identity | Stdout retained, stderr explicitly labelled; complete structured result also inspectable |
| Exit, duration, background task ids/output paths | Exit field always absent; most result metadata discarded | Provider exit field populates tool lifecycle; result metadata retains duration/background ids/paths. Never fabricate an absent value |
| Provider-persisted large output | Provider path could be lost when flattening | Path/size and provider truncation notices retained; arbitrary result paths are deliberately not auto-read. This does not recover bytes Claude itself omitted from JSONL |
| File edits/diffs | Input absent; unrecognized result object could disappear | Old/new arguments and provider result retained, structuredPatch hunks rendered as a diff; paths and counts inspectable |
| Reads, searches, counts, paths | Compact title plus selected output fields; input/counts lost | Full arguments and result metadata retained. Explicit read-only hiding preference remains honored |
| Thinking | Main-thread content retained; display preference may collapse/group | Retained; unchanged preference. No hidden thinking is invented when provider does not emit it |
| Assistant text between tools | Usually per-message prose; mixed records could lose tools | Prose retained separately in order; mixed records retain tools too. No inferred progress phase |
| Todos / plans | Tool row without input | Full TodoWrite/plan payload visible in arguments; existing plan-approval flow unchanged |
| Hook output | Bare lifecycle chatter filtered; native system/attachment records skipped | Hook response output, errors/context and selected user-facing hook attachments become receipts; silent successful bookkeeping remains omitted |
| Denials, errors, retries | Failed tools shown, retry system metadata often skipped in history | Tool failure/output retained, retry attempt/delay/error receipts restored. Existing approval receipts unchanged |
| Compaction | Live lifecycle supported; native boundaries skipped | Native boundaries restored as first-class compaction receipts |
| Slash commands / native command XML | Bookkeeping wrappers omitted | Deliberately unchanged: terminal-local commands/control envelopes are not ordinary user prose. Actual user prompts and existing compaction/plan actions remain separate |
| Token / cost lines | Usage accounted outside transcript; native cost-state ignored as prose | Existing usage surface retained; no duplicate per-token transcript rows. Agent result token/duration metadata remains inspectable |
| Default tool visibility | Collapsed work-session group then another click to tool | Claude builtins remain compact standalone rows in default mode; one click to report/arguments/child summaries |
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
using that existing detail variant; no other harness execution or model input
changed. Existing native mobile full-item fetching is reused. Swift clients and
older clients ignore the additive dynamic evidence field and keep the ordinary
parent title/report; they do not gain the new child renderer in this branch.

## Validation

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
