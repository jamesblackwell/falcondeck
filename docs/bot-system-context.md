# Stable bot context rollout

Both rollout switches default off. Settings → General → Agents → **Stable
instructions for all bots** sets `bot_system_context_enabled`. The bot editor's
**Stable bot instructions** sets `system_context_enabled`; omission preserves it.
The global switch enables every Claude/Codex bot regardless of its individual
switch. Installing code does not change live preferences. Other providers retain
legacy per-turn injection.

## Claude resume limitation and live edits

Real-CLI testing reported on 7 November 2026 showed that Claude can ignore a new
or changed `--append-system-prompt` on `--resume`. The changed append became visible
only after `/compact`. Passing correct argv does **not** prove that the model saw
the instructions. The earlier claim that a resumed thread immediately rewrites
its system/cache prefix was incorrect.

Fresh Claude sessions receive standing guidance through `--append-system-prompt`.
For resumed sessions, FalconDeck also carries changed configuration in a one-off
`falcondeck_bot_context_update` inside the next normal turn's user input:

- A missing or mismatched delivery receipt causes current standing guidance to be
  sent once. This covers existing live threads during rollout and changed native
  session IDs. Fresh sessions avoid a duplicate of their native standing append.
- Instruction/configuration edits send the current standing block once. Changed
  attached files send only their changed, bounded contents; unchanged guidance and
  files are omitted. Detached files produce a removal note. Bodies are capped at
  64 KB each, with a prompt to read the rest. Truncated-file tail edits are detected
  using size/modification metadata as well as the bounded contents.
- Receipts advance only after a successful Claude turn. Failed starts, failures
  and cancellation do not consume an update. Interrupt admission and successful
  result acceptance share one runtime boundary: an interrupt accepted first blocks
  acknowledgement; a stop after success retires the parked CLI without cancelling
  the completed turn. A crash or receipt write failure can
  cause a safe repeat on retry; it cannot acknowledge undelivered changes.
- Unchanged successful turns carry no repeated configuration and do not rewrite
  the receipt. Upkeep, new delegation reports, handoffs and sparse hints still
  arrive as before. No compaction is forced and no extra model turn is created.

Each dispatch freezes its bot profile, delivery mode, instruction bytes, file
snapshots and receipt candidate before durable turn persistence. Edits during that
wait apply on the following dispatch. A running turn keeps its initial snapshot.
Receipts are saved before the thread becomes idle and queues advance.

The launch append still changes on instruction edits, so a parked Claude process
is reconstructed with current arguments. This includes generic FalconDeck append
edits even with both bot switches off. **That updates arguments, not guaranteed
model-visible system instructions on resume.** The one-off bridge applies to
enabled bots; legacy bot edits continue to arrive in their full per-turn block.

## Where each context part goes

| Part | Enabled destination |
| --- | --- |
| Built-in guidance, bot name and editable instructions | Native system/developer append; Claude also bridges unknown/changed standing configuration once through user input. |
| Document-space path and task-creation capability | Same standing configuration. Permission enforcement remains daemon-side. |
| Context-file paths | Sorted standing manifest. File bytes and timestamps never enter the native system append. |
| Attached context-file contents, including attached MEMORY.md / STATUS.md | Claude: bounded contents on attachment/change only. Codex: read on demand from the manifest. |
| Bot-space MEMORY.md / STATUS.md that are not attached | Read on demand; standing guidance requests fresh reads when relevant, especially after resume/compaction. |
| SHARED.md | Same attached-file policy; size warnings remain in upkeep. |
| Upkeep | Per-turn notes about missing/stale STATUS and oversized files. |
| Document filenames | List/read document space on demand. |
| Other bots, resting status and activity-ordered projects | Existing coordination inventory/tools and peers' STATUS files on demand. |
| Delegation outcomes, handoffs and sparse hints | Existing per-turn delivery/acknowledgement path. |

Context previews label configured native guidance separately from upkeep. The
one-off change bridge is additional user input, not a native-system rewrite.
Previously repeated blocks already in history remain until native compaction;
this feature does not edit provider transcripts.

## Codex: real-provider retention unverified

Codex receives `developerInstructions` on native `thread/start` and `thread/resume`;
`baseInstructions` is untouched. Fresh homes, switched homes and `run_as_bot`
automation threads receive the append at creation. Dispatch unsubscribes and
resumes a loaded thread when its bot append changes because the upstream
[thread processor](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_processor.rs)
ignores instruction overrides on an already loaded thread. Native compaction uses
`thread/compact/start`.

**Codex model visibility and retention across real resume/compaction have not
been verified against a real provider.** Stub tests prove JSON-RPC bytes and
application dispatch/tracking only. They cannot establish model-level behavior;
Claude's result shows why this distinction matters. No real Codex call was made
under the no-real-provider test rule.

A pre-existing empty, unpersisted Codex thread cannot safely unsubscribe before its
first turn. Changing its context fails clearly. New and switched homes created
with the rollout enabled install the intended append at native start.

## Restart, cost and rollback

A daemon restart resolves current settings automatically on the next home or
scheduled bot dispatch. Claude receipts survive restart, so unchanged configuration
does not repeat solely because the daemon restarted. Existing in-progress work
follows normal shutdown interruption/recovery. No receipt is committed for an
interrupted turn. Receipt state is bound to the native session, not just a sidebar ID.
Observing legacy mode invalidates the receipt so re-enabling cannot trust delivery
from before a legacy turn or compaction.

For a resumed Claude conversation, enabling or editing this feature is **not an
expected full cache-prefix rewrite**: the native append may remain unchanged until
compaction. The change bridge adds one ordinary user-context block to history.
Its later reads and eventual compaction still have their normal costs, but each
unchanged turn does not accumulate another copy. Frequent edits to a large attached
file can still be expensive; only changed files are sent, without forcing the
roughly $0.60 compaction reported in the investigation.

Only optional preferences/profile flags and hash-only receipt sidecars are
persisted. `bot-context-delivery/` contains native session IDs, standing hashes and
file-path/hash maps, never instructions, file contents or conversation history.
There is no new field in AutomationRun, the control store or shared persisted
thread types. All older daemons ignore the sidecar directory; there is no store
quarantine or loss of automations. Versions predating the rollout ignore/drop its
flags and use legacy injection. Rolling back to a version with the native-only
rollout keeps its flags and restores the Claude live-edit limitation. Disable the
global and any per-bot rollout flags if legacy delivery is needed on that version.

## Other providers and verification

ACP's upstream schema has an [unstable negotiated systemPrompt capability](https://docs.rs/agent-client-protocol-schema/latest/src/agent_client_protocol_schema/v1/agent.rs.html).
This integration currently sends `instructions` only at session creation. Grok
shares ACP. Native OpenCode supports a [per-message system field](https://docs.opencode.ai/docs/server/#messages),
but this integration does not wire/prove its standing retention lifecycle.
ACP/Grok/OpenCode/Antigravity remain on legacy bot injection in this rollout.

Tests check actual Claude stub stdin through initial resume, warm turns, instruction
edits and attached-file edits: updates arrive once, unchanged turns omit them, and
no `/compact` is sent. They also cover hash-only receipts across a reconstructed
app, failed delivery, fresh sessions without duplicate standing text, and immutable
dispatch snapshots. Existing native argv/RPC tests are transport tests, not proof
of model retention. Real Claude resume semantics above come from the reported CLI
experiment; model behavior is not simulated by those transport assertions.
