# Stable bot context rollout

Claude and Codex can keep bot guidance in their native system/developer slot
instead of copying it into every user turn. Both switches default off:

- Settings → General → Agents → **Stable instructions for all bots** updates
  `bot_system_context_enabled` through the existing preferences API.
- The bot editor → Context → **Stable bot instructions** updates
  `BotMutation::Update.system_context_enabled`. Omission preserves its value.

The global setting enables every supported bot, regardless of its individual
switch. No live preferences are changed by installing this code. Unsupported
providers retain the existing complete per-turn context even when enabled.

## Where each context part goes

| Existing part | Enabled Claude/Codex destination | Reason |
| --- | --- | --- |
| Built-in guidance and bot name | System slot | Stable configuration; native compaction retains system/developer instructions. |
| User's bot instructions | System slot | Standing rules; explicit edits change the next native construction. |
| Context files | Sorted path manifest in system; contents read on demand | Even an attached file that looks stable can change. No file contents, timestamps, errors or truncation notes enter the prefix. |
| Attached MEMORY.md and STATUS.md | Same on-demand file policy | Frequently edited working memory must not mutate the system prefix. Guidance points to the bot's document space and asks for relevant fresh reads after resume/compaction. |
| SHARED.md | Path manifest; size warnings in per-turn upkeep | Shared content changes independently of this bot. |
| Upkeep | Per-turn input | Missing/stale STATUS and oversized files still produce actionable notes. |
| Document-space path and task-creation capability | System slot | Configuration, not discovered inventory. Permission enforcement remains daemon-side. |
| Document filenames | Read/list document space on demand | Creating a note must not change the prefix. |
| Other bots and resting status | `falcondeck_list_threads` inventory and peers' STATUS files on demand | Never freeze changing status in system text. |
| Activity-ordered project list | Existing coordination inventory/tools on demand | Activity cannot invalidate the prefix; project name/path locators remain supported. |
| Delegation outcomes | Per-turn input, existing delivery/acknowledgement path | New reports remain available without repeating standing guidance. |
| Handoff context and sparse hints | Existing per-turn path | Event/turn-specific information. |

Attached files are no longer automatically pasted into each enabled turn. The
standing manifest tells the model to read relevant files fresh and to suggest
edits unless authorized. This avoids copying changing MEMORY/STATUS into every
message; their actual reads remain native tool history. The context inspector
labels system-slot guidance and per-turn upkeep separately.

## Native lifecycle and first turn

Claude receives the append through `--append-system-prompt`, including each
`--resume` after its five-minute parked-process retirement. Unchanged text reuses
a warm process. Changed append bytes force a new process at the next dispatched
turn, so a just-enabled bot never loses its rules while reusing an old process.
An in-progress turn is not restarted merely by changing preferences.
The same construction comparison intentionally covers the generic FalconDeck
agent-context append even when both bot switches are off. Editing that append
refreshes a parked Claude process on its next dispatched turn; unchanged bytes
continue to reuse it. A running turn keeps its original instructions.

Each dispatch snapshots the bot profile, rollout mode and native instruction bytes
before building its user input. That immutable plan also supplies native spawn/
resume and Codex's installed-context tracking. Preference edits while durable turn
persistence is pending apply to the following dispatch, not half of this one.

Codex receives `developerInstructions` on `thread/start` and `thread/resume`;
`baseInstructions` remains untouched. Fresh bot homes and `run_as_bot` automation
threads receive the append at creation. Existing loaded idle threads unsubscribe
and resume before a turn when their bot append changes: Codex ignores instruction
overrides on an already loaded thread. Native compaction uses
`thread/compact/start`; it does not cause a FalconDeck user-context injection.
A newly created, still-unpersisted Codex thread cannot be unsubscribed safely;
changing its bot context before its first native turn fails clearly rather than
silently using the old rules. Create such bots with the global setting already
enabled, or complete that first turn before changing its context.

A daemon restart clears live runtimes/subscriptions. On the next dispatched turn,
each persisted home and scheduled bot run resolves current settings automatically;
no per-home migration or manual resume is needed. Existing in-progress work follows
normal shutdown interruption and saved-session recovery policy. A setting change
does not itself create a paid turn or rewrite conversation history.

Switching an existing conversation is expected to cause one full prefix/cache
rewrite attributable to this changed system append. Later warm turns use the same
bytes; project activity, peer status and document edits cannot change them. Ordinary
provider expiry, model changes and native compaction still have their normal costs.
The old repeated blocks already in history remain until native compaction; this
feature prevents new copies and does not edit provider transcripts.

Edits to standing instructions take effect at the next dispatched turn by forcing
the idle native construction to refresh. A running turn continues with its old
instructions until it ends; five-minute idle retirement and daemon restart also
pick up edits. A continuously running turn has no fixed refresh deadline.

## Other providers and rollback

ACP's upstream schema has an [unstable, negotiated `systemPrompt` capability](https://docs.rs/agent-client-protocol-schema/latest/src/agent_client_protocol_schema/v1/agent.rs.html)
for new/load/resume. FalconDeck currently sends an optional `instructions` field
only on `session/new`; it does not negotiate or use that system-prompt lifecycle.
Grok follows this ACP path with model/permission metadata. Neither gets this rollout.

Native OpenCode does support a [per-message `system` field](https://docs.opencode.ai/docs/server/#messages).
FalconDeck's native prompt integration currently sends text/files without a standing
system append; retention through native compaction/resume has not been verified.
It and the OpenCode ACP fallback keep legacy injection in this change, as do
Antigravity and the other ACP harnesses. These are integration limits, not a claim
that those providers cannot support system instructions.

Only optional preferences and bot-profile fields are persisted. Their existing
serde containers accept unknown fields; older daemons ignore these switches and
return to legacy per-turn injection, with no control-store quarantine. Saving
preferences on an older daemon may discard the switches. No AutomationRun,
control-store field or schema version changes are introduced.

## Verification

Stub-level native transport tests cover Claude's actual argv/stdin through warm
reuse, compaction command/boundary, five-minute idle retirement, `--resume`, and
instruction edits; Codex's JSON-RPC developer instructions through start, compaction,
unsubscribe and resume. App-level tests verify stable bytes despite document and
activity changes, rollout defaults, automation bot identity, and upkeep. Delegation
coverage runs with the global switch enabled. These tests use no real providers;
provider-native retention is exercised at the transport boundary, not with paid
model calls.

Codex's loaded-thread override behavior is documented in its
[thread processor](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_processor.rs).

A read-only rendering of a saved bot profile on 7 November 2026
measured **8,715 bytes per legacy turn**, **0 bytes of bot context per enabled turn**
when there were no upkeep warnings or new reports, and **7,189 stable system bytes**.
New delegation reports, handoffs and upkeep still add their own per-turn bytes.
