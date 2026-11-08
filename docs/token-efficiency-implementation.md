# Token efficiency fixes 3–5

Implementation branch: `token-efficiency-3-5`, based on main `b06c5eb3`.
The [original review](token-efficiency-review.md) is imported unchanged from
`279e698e`. Fixes 1 and 2 are outside this change.

## Idle bot-home compaction (3)

Settings → General → Agents → **Compact idle bot homes** controls
`bot_idle_compaction_enabled` (default true; false disables it). Older clients
may omit the field. The daemon checks active bot homes once per scheduler poll
(normally within a minute), using the same admission gate and native compaction
implementation as `POST /api/workspaces/{ws}/threads/{id}/compact`.

Only Claude homes qualify: its one-hour cache lifetime is measured in the
existing analytics. No lifetime assumption is made for Codex or ACP. A home
needs a native session, at least 150,000 context tokens from live counters,
50 minutes without a thread update, and a last model-usage report aged
50–55 minutes. Running, waiting, errored, archived, paused, queued and
currently-dispatching threads are skipped. Homes with a positive background
count or raw CLI task ownership are also skipped, even after the visible
count ages out. Background parent wakes and final maintenance admission share
the thread admission gate. Raw ownership is scoped to the CLI generation,
so an old monitor cannot clear a newer monitor's tasks. Former homes and
bot-created tasks are excluded. Missing counters/timestamps (including after restart) are skipped.
A maintenance attempt consumes one ordinary-activity generation before
dispatch. Only admission of an ordinary prompt clears that marker; maintenance
usage, completion and later scheduler intervals do not. Native-history
rehydration preserves both maintenance and live-task ownership markers.
The marker is runtime state, like the live context counters; restart alone cannot reconstruct an
eligible context. The eligibility check runs again under admission and after
history preparation;
a wake after sleep never catches up on an expired cache. No user message,
keep-warm ping or conversation store is added.

Weekly estimate from the review's analytics/transcript replay: **$156 alone,
$86 additional after fixes 1 and 2** at list-equivalent prices. The replay saw
44 returning homes and one non-returning home in 4.10 days. The five-minute
startup safety margin and skipped sleep windows make $86 a ceiling for this
implementation rather than a promised saving. Existing usage, `compact`
events and the Analytics Cache/Waste reports can measure rebuilds and
compaction cost after installation. Risks: compaction replaces detail with a
summary and can delay a message arriving during maintenance. Bot memory,
STATUS and result-receipt instructions are retained.

Tests cover size/time boundaries, missing counters, unsupported harnesses,
busy/errored/archived homes, queued work, persistence/default/off behavior,
normalization, the UI switch, and a preference change before gated admission.

## Model-facing tool output (4)

FalconDeck's control and extension MCP bridges limit oversized JSON/text
results to a **24,000-byte preview**, roughly 10k tokens at the review's measured
2.43 characters/token. The preview retains both ends, explicitly marks the
omitted middle, and names the original tool, a retained-output handle and the
`falcondeck_read_tool_output` tool. Small structured results
retain their exact shape. Oversized results are marked `truncated` with their
original byte count; the full value is not duplicated in `structuredContent`.
UTF-8 boundaries and JSON escaping are accounted for. Single-operation control
discovery first removes output-schema prose and titles so complete input rules,
examples and validation constraints remain usable under the cap. HTTP schemas
are unchanged; a regression check covers every published operation. Truncation happens in the MCP response; extension host state and shell
transcript processing are not rewritten.
This applies to every harness using these FalconDeck MCP bridges, including
Codex, Claude and ACP; external MCP servers and native harness tools are
outside this boundary.

Claude additionally receives `BASH_MAX_OUTPUT_LENGTH=24000` and the supported
`bashOutputMaxChars: 24000` launch setting, with or without approval hooks.
The setting prevents a larger user setting from overriding the environment
limit on newer CLI versions; the environment is the older-version fallback.
Claude owns native Bash behavior: successful overflow gets its native file
path/preview, and failed commands get its native head-and-tail excerpt.
Both the head and tail come from Claude's **read-back window**. The actual end
of a huge failing command's output is therefore not guaranteed to appear.
The recovery store below covers MCP results, not native Bash output.
FalconDeck does not rewrite shell commands or claim it controls Codex/ACP
native shell output. See Claude's [output limits](https://code.claude.com/docs/en/tools-reference#output-limits)
and [environment reference](https://code.claude.com/docs/en/env-vars).

Weekly estimate: **about $8 standalone for Bash**, plus a small unquantified
MCP saving. This deliberately differs from the review's $84: that used **10k
characters**, whereas the approved request says **10k tokens**. The existing
replay gives $13/week at 20k chars and zero at the previous 30k ceiling;
linear interpolation to 24k is $7.80 (low confidence). Applying the review's
71/84 marginal/standalone ratio gives about **$6.60/week after earlier fixes**.
The full $39/week of FalconDeck MCP carry is only a gross upper bound, not a
saving. Token density varies; a byte cap is approximate, not a model tokenizer.

Tests cover complete single-operation discovery and unchanged input rules,
unchanged small/error payloads, oversized success/error results,
head/tail retention, multibyte text, escaping and both Claude approval modes.
Risks: an important native Bash diagnostic in the omitted middle may need
a read of Claude's saved output or a narrower command. Oversized MCP results
use a preview inline and a retained original; never repeat a mutating tool
just to recover its output. Recovery reads can offset savings.

## Startup context (5)

The always-on FalconDeck append and control/session-tool descriptions are
shorter. Duplicate tool inventories and examples already available in tool
schemas or the on-demand MCP/control skills are removed. The MCP skill's
catalog description is shortened. Bot standing instructions, STATUS/MEMORY,
report acknowledgements, durable waits, restart verification, notification
privacy, approval boundaries and current-thread scheduling remain available.
No plugins, user skills, native harness prompts, sandbox policy or user files
are disabled or edited.

FalconDeck Dev confirmed the scope on 8 November: owned append and tool
descriptions only; accept the smaller saving and leave cross-project setup
alone. The current owned-context reduction is **about 1.8k tokens**, using the review's
2.8 chars/token: 2,560 characters from the append, 1,011 from the three control
tool descriptions, 1,190 from session-tool descriptions, and 280 from the MCP
skill description. The tools may be deferred, so not every harness pays all
of these on its first call. A size-budget regression assertion protects the
always-on append alongside its existing semantic assertions.

The review's 6k-token scenario saves $64/week alone or $75 marginally. Scaling
by the implemented reduction gives **about $19 alone / $22.50 marginal per week**,
an upper estimate because tool-loading coverage differs. This does **not**
claim the full 6k-token target: the review attributes most of that to native
skill/plugin catalogs and user/project instructions. Those are explicitly outside this task; the supplied user-level AGENTS.md and
CLAUDE.md are already only 614 bytes combined. Identical skill copies remain
in the user's native catalogs. These are not silently deleted by a daemon
upgrade.

All figures are subscription limit headroom/list-equivalent cost, not invoice
reductions. They inherit the review's short-window and quality limitations.
Use [Analytics](ANALYTICS.md) to compare a representative week after install;
do not add standalone estimates to the original combined-replay total.


## Reproduce the estimate

Run `python3 scripts/token-efficiency-estimate.py --state-dir ~/.falcondeck`.
It reads only local Analytics usage JSONL and source text, deduplicates usage
IDs, and prints aggregates rather than messages, thread IDs or credentials.
The default window matches the original review. On 8 November this produced
3,413 Claude usage records, $3,434/week reported list-equivalent cost, 8.443B
cache-read tokens/week, and 212.0M cache-write tokens/week. This is a cross-check
of the baseline, not a replacement replay: its per-turn Analytics totals differ
slightly from transcript-derived totals and omit hidden compaction calls.
It measured 5,041 characters (approximately 1,800 tokens) removed and calculates
$7.80/week for Bash and $22.50/week marginally for this context trim. The script
labels the original $86 idle-compaction estimate as a replay ceiling.


Largest remaining non-FalconDeck catalog contributors in the review: Codex
skills ≈14.4k tokens, Claude skills ≈9.3k, deferred MCP names ≈2.1k, and Claude's
agent catalog ≈1k (all approximate at 2.8 chars/token; harnesses differ). User
instructions add ≈5.8k tokens on Claude. These figures overlap across sessions
and are not additive savings.

## Validation on 8 November

Clean main `b06c5eb3` baseline (the user's dirty main files were excluded):

- `npm run typecheck`: three existing chat-ui test type errors: unsupported
  `exact` in a role query and two textarea queries typed as `HTMLElement`.
- Desktop: 1,561 passed, two failed, one skipped (154 files). Both failures
  were stale App.activity navigation expectations: Plugins moved to Options,
  and Cloud execution moved into the composer. RemotePairingPopover passed;
  its two previously reported failures did not reproduce on this main.
- Chat-ui: 247 passed in 41 files.

The branch fixes those test-only issues: role-query typing, textarea typing,
current Plugins navigation, and the Cloud composer integration fixture. The
fixture now renders its actual context bar and supplies the correct branch
response shape; the lazy Settings assertion allows time for its chunk to load.
No production navigation or pairing behavior changes.

Branch checks: workspace-wide `npm run typecheck` passed; desktop 1,564 passed,
one skipped (154 files); chat-ui 247 passed (41 files); client-core 836 passed
(80 files). Vitest used `--maxWorkers=2`.

`.agents/skills/autoreview/scripts/autoreview --mode local --no-web-search`
reported clean, with no actionable P0 findings (the helper's default threshold).

Full daemon command: `cargo test -p falcondeck-daemon -j 4 -- --test-threads=4`.
Result: **2,045 unit tests and 55 integration tests passed**, no failures;
11 unit tests and one integration test were ignored. Doc tests passed (none).
The schema-discovery regression is covered both across every published
operation and by the end-to-end automation-creation MCP conversation.

Heavy checks ran between 14:30 and 14:47 London time with nice priority 10,
a ≥20 GiB free-space check, and a private Cargo target directory. Daemon tests
kept the real HOME, set `FALCONDECK_TEST_NO_PROVIDERS=1`, used a private TMPDIR
under `/private/tmp`, and put failing agy/claude/codex/cursor-agent/opencode/open
stubs first on PATH. No live pairing/device calls, merge, install or restart
were performed. The protected dirty main files were unchanged.


## Independent review corrections

Both MCP servers publish `falcondeck_read_tool_output(handle, offset, limit)`.
Before inline truncation, the bridge stores the complete original MCP result
in daemon memory, including `content`, `structuredContent`, `isError` and
extension metadata. Opaque handles survive bridge-process exit but not daemon
restart. The cache retains at most 32 entries, expires handles after 24 hours,
and uses a 32 MiB total budget; oldest entries are evicted first. Expired entries
are removed lazily on cache operations. No output bodies are written to disk,
put in snapshots, or registered as relay RPC.

Ranges contain UTF-8 JSON text with byte offsets, `next_offset`, `total_bytes`
and `eof`. Concatenate the ranges and parse the JSON to recover the original
MCP result, including its structured content. Limits are clamped so every
range remains under the inline cap, even after JSON escaping. Reads neither
repeat the original call nor consume another cache entry. Unknown, expired,
evicted or restart-lost handles return explicit tool errors. Results beyond
the store's 32 MiB transport budget fail retention explicitly and tell the
agent that the original call completed and must not be repeated blindly.

Tests cover a 64k review.get body, an extension mutation with no owner-side
paging, exact reconstruction including structured content and metadata,
UTF-8 offsets, expiry/unknown/evicted handles, and an owner-call counter proving
that range recovery does not rerun the mutation. Admission tests cover Idle
with visible or aged-out live background work and repeated intervals after
maintenance while counters remain high. A new ordinary admission opens the
next maintenance generation.

The recovery tool adds a small catalog cost on each MCP server. The earlier
startup-trim estimate describes the original text reduction, not a newly
measured net saving after these correctness fixes.

### Correction validation

On 8 November, `cargo test -p falcondeck-daemon -j 4 -- --test-threads=4`
passed: **2,047 unit tests and 55 integration tests**, with 11 unit tests and
one integration test ignored. Doc tests passed (none). Six focused reruns
against the same compiled library-test binary also passed (11 tests total):
`tool_output::tests`, `recovered`, `idle_bot_compaction`,
`only_large_warm_idle_homes`, `stale_claude_monitor`, and
`reconnect_keeps_idle_maintenance`. The recovery round trips assert that every
read result stays under the cap and that the original owner is called once.

These checks ran at 15:30–15:42 London time, with nice priority 10, Cargo
`-j 4`, and a ≥20 GiB free-space check before each run. They used the real HOME,
`FALCONDECK_TEST_NO_PROVIDERS=1`, failing provider/open stubs first on PATH,
and a private TMPDIR under `/private/tmp`. The private target directory was
removed after the full suite; focused reruns used its retained test binary.
No TypeScript changed in the corrections, so the earlier passing workspace
typecheck and TS-suite results above were not rerun.

Repo-local `autoreview --mode local --no-web-search` was clean at its default
P0 threshold. No merge, install, restart or live pairing/device/relay calls
were made. Other agents' dirty main files were left alone.

### Recovery ownership

A handle alone grants no access. Insert and read resolve the bridge's existing
spawn context in the daemon: control MCP requires an enabled MCP origin,
provider and registered workspace/thread; extension MCP requires its valid
daemon-issued bridge capability. Workspace-wide bridges use the same in-flight
call or unambiguous running-thread resolver as ordinary calls. Ambiguous or
missing identity fails closed. Original argument shapes are preserved for
in-flight matching, including omitted defaults.

Each retained result is bound to that thread, its resolved bot (if any), and
its extension capability (if applicable). The model cannot supply an owner
field. Reads revalidate current authority, including capability expiry or
revocation. A missing handle and a handle owned by someone else return the
same `Unknown or expired tool-output handle` error. A bridge process can
restart and recover with the same daemon-issued identity; a newly issued
extension capability does not inherit the old capability's outputs.

Ownership correction validation (8 November): the full daemon command above
passed **2,049 unit tests and 55 integration tests** (11 unit tests and one
integration test ignored), including the new HTTP ownership/revocation and
32 MiB pressure regressions. Existing control/extension bridge recovery round
trips also passed with identity forwarding enabled. The ownership test uses
two configured bots, rejects invalid insert identities and model-supplied owner
fields, checks identical unknown/not-owned errors, and recovers with a fresh
bridge client carrying the same issued identity. No TypeScript changed.
Repo-local autoreview was clean at its default P0 threshold.

Heavy checks ran at 15:49–15:56 London with nice 10, Cargo `-j 4`, real HOME,
`FALCONDECK_TEST_NO_PROVIDERS=1`, failing provider/open stubs first on PATH, a
private `/private/tmp` TMPDIR and a private target directory. The initial
≥20 GiB check passed. After the full suite, disk guards blocked separate
focused reruns; the regressions had all passed in the full suite. The private
build artifacts were deleted. No merge, install, restart or live
pairing/device/relay calls were made.
