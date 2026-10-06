# Hermes ACP qualification

Recorded on 2026-10-06 for Phases 0–3 of [the integration plan](HERMES-INTEGRATION-PLAN.md). Hermes is discoverable through native ACP. Historical qualification is followed by runtime, interaction, native-history, and connector results. Full cross-client release qualification remains in Phase 4.

## Baselines and configuration

| Baseline | Executable / source | Version |
| --- | --- | --- |
| Existing installation | `~/.local/bin/hermes` → `~/.hermes/hermes-agent/venv/bin/hermes`; source `5a3317693c6ddd84834c4684eb6929ade20f0962` | `hermes acp --version`: `0.14.0` |
| Disposable current source | Separate editable installation of [revision `1d6b2786e2b2de70a967c66b6a14e2b83bab30e7`](https://github.com/NousResearch/hermes-agent/tree/1d6b2786e2b2de70a967c66b6a14e2b83bab30e7), using Python 3.14.6 and the source's ACP extra | `hermes-acp --version`: `git.1d6b278`; initialization's `agentInfo.version` says `unknown` |

Both use `agent-client-protocol` 0.9.0 and negotiate ACP protocol 1. Both pass `--check`. The existing source checkout was clean and was **not upgraded**. The current source ran in a temporary virtual environment with a private temporary `HERMES_HOME`, seeded from the existing model configuration. The existing installation used its normal `~/.hermes` profile. Credentials were never added to repository files. Existing Hermes `.env`, `config.yaml`, and FalconDeck `providers.json` were checked by digest before and after qualification.

The configured default `openai-codex:gpt-5.4` is advertised but the account rejects it with HTTP 400. Live qualification selected the advertised, working `openai-codex:gpt-5.6-luna` **per session**, without changing the saved default. This distinction matters: initialization and model discovery alone do not establish that the configured model works.

All model/tool requests were diagnostic prompts in disposable project folders. For the older installation's edit test the folder was under `/tmp`: its write tool treats macOS's `/private/var/folders` temporary directories as sensitive system paths. The current source accepted the normal macOS temporary directory. Before replacing an existing file, the edit test read its full content to satisfy Hermes' overwrite protection.

## Phase 0/1 results

| Behavior | Existing installation | Disposable current source |
| --- | --- | --- |
| Initialization and session creation | Pass | Pass |
| Model inventory | 8 models | 53 models |
| Model setter | Accepts `session/set_model`, including invalid model IDs | Working model selected; invalid model rejected with JSON-RPC `-32602` and useful `data.details` |
| Modes | `default`, `accept_edits`, `dont_ask` | Same three edit modes |
| Separate permission/reasoning inventory | Neither advertised | Neither advertised |
| Text streaming | Pass: expected marker received | Pass: expected marker received |
| File read | File read and reply pass; **live completion event missing** | Start, completion, tool output, and reply pass |
| Controlled edit, mode `default` | One approval; allowed file changed to expected content | One approval; allowed file changed to expected content; completion event received |
| Denied edit | One denial; file unchanged | One denial; file unchanged; failed tool update received |
| Cancellation | `session/cancel` returns `cancelled` | Same; a subsequent prompt in that session also passes |
| Same-process `session/load` | Pass: 10 replay updates | Pass: 12 replay updates |
| Load after process restart | Pass: 10 replay updates | Pass: 12 replay updates |
| Usage and native session title | Received | Received, including additive provenance metadata |
| Missing credentials | Existing credentials left intact | Empty home and scrubbed environment: session creation returns `-32603`, with `data.details` explaining `hermes model` / login / key setup |
| Missing ACP dependency | Installation left intact | Fault injection blocks only the `acp` import: `--check` exits 1 with `ModuleNotFoundError`; no dependency was removed or auto-installed |
| Provider HTTP 400 | `end_turn`, no assistant text and no prompt usage | `end_turn`, assistant prose describing rejection; no prompt usage |
| Image prompts | Advertised; model image handling untested | Advertised; model image handling untested |
| MCP transports | HTTP/SSE not advertised; server execution untested | Same |
| Unknown update discriminants | None | None |
| Available commands | Received but not projected by FalconDeck | Same |

The installed baseline's live/restart conformance command exits 1 because its read has no live `tool_call_update`. The current-source baseline exits 0 with all exercised checks passing. Authentication, unexercised MCP transports, and unprojected command discovery remain warnings. Reload reconstructs completed tools on the older baseline; that does not repair its missing live event.

## Verified fixes in FalconDeck

1. **Conformance model selection.** The probe previously reported an advertised model as selected when the adapter lacked a model config option. It now calls legacy `session/set_model` in that case, matching the production runtime. A regression requires this setter before any live prompt. This fixed the false qualification failure against the rejected default model.
2. **Provider failure versus `end_turn`.** Both recorded Hermes baselines log a `Non-retryable client error` on stderr while returning a successful-looking stop reason. The ACP runtime now recognizes this specific Hermes error, emits a failed `TurnEnded`, and returns a failed prompt result so the task cannot reset the thread to idle. This covers both empty content and rendered error prose. It does not infer failures from arbitrary assistant text or ordinary tool errors. Diagnostics name the configured agent rather than incorrectly naming OpenCode.
3. **Discovery.** Settings offers `hermes acp`, explicit ACP transport, installation instructions, and terminal `hermes model` guidance using the same profile. An existing `hermes` entry counts as configured and retains its command, label, environment, and transport. Writes retain the revision check and other providers. Harness inventory detects Hermes locally and over SSH, using the concise `acp --version` entry point for Hermes launchers. A failing shell regression also demonstrated that SSH inventory skipped `~/.local/bin` when the noninteractive PATH lacked it; primary resolution now searches the existing known locations before declaring a binary missing.

Hermes has no npm latest-version lookup, authentication probe, or managed upgrade command. Update through the owner of the existing installation: a source checkout, packaged desktop install, Docker image, and Nix installation need different update paths. The installed May build's tool event defect is already fixed in the pinned current source; FalconDeck does not patch the user's Python checkout or run its installer over an existing install.

## Fixtures and checks

[`hermes_acp.json`](../crates/falcondeck-daemon/tests/fixtures/hermes_acp.json) contains bounded recorded initialization, session/model/mode metadata, streaming and replay events, usage, edit permission options/diffs, completed and denied tools, and model/credential/provider errors. IDs and local paths are normalized; the model inventory is reduced to two observed entries. Image support appears only in the recorded advertisement. Provider failure details are normalized to the unsupported-model cause.

Rust tests feed the captured frames through production session metadata parsing, `handle_message`, tool projection, history/usage projection, permission parsing, and JSON-RPC error detail extraction. The executable fixture replays the recorded empty and prose error shapes, with stderr arriving after the prompt response, and asserts that each ends as a failed turn. An unscoped provider stderr line is used only when one prompt is active; a regression prevents assigning it to unrelated concurrent prompts.

Focused checks:

```sh
cargo test -p falcondeck-daemon --lib acp::tests
cargo test -p falcondeck-daemon --lib app::harness_manager::tests
cargo test -p falcondeck-daemon --lib agent_binary::tests
cargo test -p falcondeck-daemon --test acp_conformance
npm run test --workspace falcondeck-desktop -- src/components/settings/AgentsPanel.test.tsx
npm run typecheck --workspace falcondeck-desktop
```

These suites pass (58 ACP unit tests, 24 harness tests, 8 binary-resolution tests, 8 conformance tests, and 17 settings tests), as does desktop typecheck. `cargo clippy -p falcondeck-daemon --lib` completes with existing warnings. Its stricter `-- -D warnings` form stops on the existing `clippy::enum_variant_names` warning for `Frame` in `falcondeck-core/src/relay_transport.rs`; unrelated lint cleanup is outside this change.

Qualification uses a rebuilt executable from the working FalconDeck source, not the older artifact from the planning turn:

```sh
cargo build -p falcondeck-daemon --example acp_conformance
# Existing installation; workspace must be disposable.
target/debug/examples/acp_conformance --json --live --restart \
  --timeout-seconds 90 --cwd "$probe_workspace" -- ~/.local/bin/hermes acp
# Pinned current source in its separate temporary installation/profile.
HERMES_HOME="$probe_profile" target/debug/examples/acp_conformance \
  --json --live --restart --timeout-seconds 90 --cwd "$probe_workspace" \
  -- "$probe_venv/bin/hermes-acp"
```

The extra focused cases use the same ACP sequence: initialize → session/new → session/set_model → session/set_mode `default` → read/write prompt → answer `allow_once` → deny a second edit with `reject_once` → verify disk contents → invalid model → restore working model → next prompt. Cancellation recovery sends `session/cancel` after a terminal tool starts, then verifies a new text prompt in the same session. Raw wire logs and temporary credential-bearing profiles remain private and are not committed.

## Phase 2 runtime and interaction results

Phase 2 used the same pinned current source (`1d6b2786e2b2de70a967c66b6a14e2b83bab30e7`), ACP SDK 0.9.0, protocol 1, and working session model `openai-codex:gpt-5.6-luna`. The installed source was checked again: clean `5a3317693c6ddd84834c4684eb6929ade20f0962`, `hermes acp --version` 0.14.0. **No installed upgrade was performed.** Tests used a disposable source checkout, project folder, and private Hermes home; native session storage remained Hermes-owned. The source's dependency manager was synchronized with the `acp` and `mcp` extras in that disposable checkout so its dependency generation also worked after process restart. Neither the installed Python environment nor its native session database was patched.

The older installed setter accepts invalid model IDs and rebuilds its agent without retaining injected MCP toolsets. Its missing live tool-completion event is also still present. The pinned October source rejects invalid IDs and retains MCP tools after model changes. An owner-managed update to a revision containing those upstream fixes is needed before relying on that complete behavior in the installed agent; FalconDeck changes cannot repair it. No upgrade was needed to implement or qualify the daemon changes separately.

| Live behavior on the pinned source | Result |
| --- | --- |
| Host guidance on a fresh session | Exact guidance marker returned |
| Invalid model | JSON-RPC rejection; working session and injected MCP tool remain usable |
| Successful model switch | Switch to `openai-codex:gpt-5.6-sol` and back; injected stdio tool returns `HERMES_PHASE2_MCP_OK` |
| Native `/compress` | Dispatches without injected prefix; 20 → 12 messages; next prompt obeys host guidance |
| Process restart after compression | Same ACP handle loads; next prompt obeys freshly supplied guidance |
| Default edit mode | Pre-execution edit approval denied; existing file unchanged |
| `accept_edits` and `dont_ask` | File creation completes without edit approval in both modes |
| Dangerous shell command in all three edit modes | Permission requested and denied; disposable target unchanged |
| Two simultaneous native sessions | Each edit permission belongs to its calling session; both denials leave files unchanged |
| Cancel a running terminal tool | `cancelled`, terminal completion update, then a successful marker prompt in the same session |
| Rebuilt current-source live/restart conformance | All exercised checks pass; 12 replay updates before and after restart; no unknown or unhandled update kinds |

The conformance report still warns about unexercised login, HTTP/SSE MCP transports, and ordinary adapter stderr diagnostics. Image support remains an advertisement rather than a live vision test. The separate stdio MCP test exercises tool execution, rather than treating the transport advertisement as proof.

FalconDeck fixes:

- Full model IDs, including named endpoint IDs, remain opaque. An idle session's model is validated before the picker is saved. A rejected queued/startup choice stops startup and restores the last acknowledged model instead of prompting with a different model. An unchanged Hermes model does not trigger an unnecessary agent rebuild.
- The native edit picker says “Ask before edits”, “Accept edits”, and “Don't ask before edits”. FalconDeck's permission policy is independent: its explicit `default` survives saving and does not reset the native edit mode. Full access auto-selects only a one-shot allow for Hermes; it never writes standing approval patterns into Hermes configuration. No reasoning setting is invented.
- Hermes ignores the extra `session/new.instructions` field. Normal prompts therefore receive bounded host guidance in the existing hidden user-text projection wrapper, on every turn and on generic cancel/resubmit steering. Context over 64 KiB fails visibly. Native commands bypass guidance and selected-skill prefixes using the advertised command inventory, with a bounded fallback before that asynchronous inventory arrives. Image-only prompts retain their image blocks. No project instructions, personal memory, or Hermes configuration are rewritten.
- Additive shared fields carry native approval labels and opaque option IDs through the existing interactive-request queue. Desktop/remote shared cards and mobile buttons return the exact selected ID; receipts retain its scope label. Selection is validated against the offered IDs. Protocol kinds determine allow/deny behavior; English labels do not determine scope. Legacy request/response shapes remain supported.
- Cancelled/finished Hermes turns reject late permissions. Denial, timeout, cancellation while waiting, and process disconnect settle pending runtime requests and daemon banners. A cancelled prompt waiting behind another thread never executes and leaves its next prompt usable.
- Hermes prompts are serialized within each workspace runtime because its provider-failure stderr lacks a session identifier. The two-session native test verifies callback routing; deterministic daemon tests additionally verify serialized error ownership and queue cancellation. Other ACP providers retain their existing prompt concurrency. Generic cancel/resubmit steering remains the chosen path; Hermes `/steer` is not substituted.

[`hermes_phase2_agent.mjs`](../crates/falcondeck-daemon/tests/fixtures/hermes_phase2_agent.mjs) deliberately supplies opaque IDs, multiple standing-grant options, and misleading labels to test exact selection through production runtime and daemon handlers. It also exercises rejected models, mode independence, timeout/disconnect/cancel settlement, late requests, and two-thread failure routing. Shared-client tests verify exact-option normalization, legacy requests, receipts, and web/mobile submission.

Phase 2 focused checks:

```sh
cargo test -p falcondeck-core --lib interactive
cargo test -p falcondeck-daemon --lib acp
cargo test -p falcondeck-daemon --lib interactive
cargo test -p falcondeck-daemon --test acp_conformance
cargo clippy -p falcondeck-daemon --lib
npm run test --workspace @falcondeck/client-core -- src/approval-options.test.ts src/interactive-request.test.ts src/normalization.test.ts
npm run test --workspace @falcondeck/chat-ui -- src/components/interactive-request-card.test.tsx
npm run test --workspace @falcondeck/mobile -- src/components/chat/InteractiveRequestBanner.test.tsx
npm run typecheck --workspace @falcondeck/client-core
npm run typecheck --workspace @falcondeck/chat-ui
npm run typecheck --workspace @falcondeck/mobile
npm run typecheck --workspace falcondeck-desktop
npm run typecheck --workspace falcondeck-remote-web
```

All focused checks pass: 3 core interactive tests, 106 daemon ACP tests, 9 daemon interactive tests, 8 conformance tests, 79 shared-client tests, 3 shared web-card tests, 16 mobile banner tests, and all five typechecks. Clippy completes with existing warnings. The current-source executable was rebuilt and its `--json --live --restart --timeout-seconds 90` qualification repeated after command discovery became consumed runtime metadata. Private raw logs and credential-bearing disposable profiles are excluded from git.

## Phase 3 native history and connector results

The installed launcher/source was checked again: clean `5a3317693c6ddd84834c4684eb6929ade20f0962`, `hermes acp --version` 0.14.0. **No installed upgrade was performed.** The same supported source `1d6b2786e2b2de70a967c66b6a14e2b83bab30e7`, ACP SDK 0.9.0, and `openai-codex:gpt-5.6-luna` ran in a disposable checkout/home. Its dependency manager was synchronized with `acp` and `mcp` extras only in that checkout. Existing Hermes configuration and native storage were not patched or replaced. The older installation still needs its owner's update for the upstream model/MCP/tool-completion fixes described above; upgrading it was unnecessary for this implementation and qualification.

### Demonstrated blockers and fixes

- Normal turn startup previously omitted the persisted session ID whenever transcript items existed. After warm process replacement this could start a blank conversation and overwrite its resume identity. Hermes now always attaches the saved ACP handle, uses strict `session/load`, and reports failure without substituting `session/new`. The regression reproduced the old fallback returning a fresh fixture ID after a rejected load.
- Hydration previously waited for the first replayed item before clearing stream accumulators and settling history. Hermes now waits for an acknowledgment on the ordered event channel after the complete load response. Long replay finishes before settlement or a following prompt. A restored thread sent directly without opening its detail first loads native history before the new user message is admitted.
- ID-less replay duplicated content when a warm process was replaced. Hermes reload suppresses only replayed conversation content if the daemon already has its projection; metadata still flows. A full daemon restart rebuilds history from native storage. Replayed repeated user text is preserved rather than mistaken for an echo of the newly submitted message.
- A live same-process probe called the same-named stdio connector in native sessions A and B with different identity/capability markers. B's actual tool call returned A's marker. The pinned source registers MCP servers by name into its process/profile registry, which is not ACP-session scoped. Serializing prompts did not isolate the connected server. FalconDeck now gives each Hermes thread its own ACP process and thread-bound built-in connector context; other adapters retain their shared workspace process. Metadata-only discovery supplies no injected MCP servers, preventing a workspace-bound discovery connection from claiming the name first.
- Re-registering a changed connector on a warm Hermes process also retained its old connection. At turn admission, FalconDeck compares the current materialized user connectors with the existing launch snapshot. A change replaces only that thread's process and reloads the same native handle. Built-in capability tokens are excluded from that comparison because freshly issuing a token is not a user configuration change. No second connector configuration store was added.

### Qualification matrix

| Case | Evidence and result |
| --- | --- |
| Current-source live/restart conformance | Exit 0: streaming, file-read tool lifecycle, cancellation, same-process load and cross-process restart pass; all observed update kinds handled |
| Warm process replacement | Deterministic daemon fixture removes/shuts down the cached owner, then continues the exact native handle with no duplicate user, assistant, or tool items; lifecycle guard tests also pass |
| Full daemon restart | An isolated real daemon, private state path and Hermes home restore the same handle, recall a prior marker, and execute the injected stdio tool |
| Long replay | 600 native turns / 1,800 user, assistant and tool items, including identical repeated user text, are fully applied and settled before hydration returns; the next turn produces exactly one additional item of each kind |
| Direct send after restore | Production admission path restores old user/tool/assistant content before appending the new user message |
| Compression then restart | Live `/compress`, process reload and full daemon restart retain the ACP handle and prior context; deterministic additive `_meta.hermes.sessionProvenance` rotates the internal head without changing the saved handle |
| Failed reload | Visible error on turn startup and background opening, unchanged native handle, no continuation prompt and no fresh replacement session; a later successful history load clears the restore error |
| Same-name connector concurrency | Two live thread-owned processes simultaneously call `identity`: A returns `A\|CAP_A\|1`, B returns `B\|CAP_B\|1`; actual stdio call traces confirm the results |
| Connector edits | Live replacement/load uses revision 2 while the other process retains revision 1. Real daemon edits apply on the next turn without changing the native handle; deterministic checks keep an active sibling runtime untouched |
| Model selection and MCP | New sessions switch from the saved default to the working provider-qualified model and still execute their injected stdio tools; the same setter works after load |
| Built-in thread/capability identity | Concurrent real daemon turns call `falcondeck_rename_thread` and change only their own titles. Deterministic daemon-issued capabilities remain bound to their thread even when the request body names another thread, including after connector refresh/load |
| HTTP/SSE and computer use | Existing negotiated transport filtering and built-in injection tests pass. Hermes still advertises neither HTTP nor SSE. No live HTTP/SSE or computer-use action was exercised |

The real daemon test enabled and granted the bundled follow-up extension only in its disposable state so the existing extensions bridge was injected. Existing extension enablement/grants and computer-use consent were preserved. Tests used a diagnostic user connector plus the built-in bridge; they did not execute users' real connectors. Raw transcripts, capability-bearing logs, and copied credentials stayed private and are excluded from git.

Thread isolation increases the number of warm Hermes processes: one per used thread, plus an optional composer discovery process. Existing retirement bounds remain 20 minutes after a served prompt and 2 minutes for discovery-only processes; an unrelated active Hermes thread no longer pins another thread's process. All processes keep the selected `HERMES_HOME`, so memory, learned skills, and native sessions remain Hermes-owned. No native SQLite reader/writer, import UI, Hermes skill catalog, or FalconDeck conversation database was introduced. Optional import through ACP `session/list` remains separate work.

Phase 3 focused checks:

```sh
cargo test -p falcondeck-daemon --lib acp
cargo test -p falcondeck-daemon --lib connectors::tests
cargo test -p falcondeck-daemon --lib runtime_health::tests
cargo test -p falcondeck-daemon --lib extension_bridge
cargo test -p falcondeck-daemon --lib persisted
cargo test -p falcondeck-daemon --test acp_conformance
cargo check -p falcondeck-daemon --lib
cargo clippy -p falcondeck-daemon --lib
```

All focused checks pass: 114 ACP tests, 29 connector tests, 9 lifecycle tests, 2 bridge tests, 13 persistence tests, and 8 conformance tests. Clippy completes with existing warnings. The ACP suite includes seven new production-daemon history/identity regressions using [`hermes_history_agent.mjs`](../crates/falcondeck-daemon/tests/fixtures/hermes_history_agent.mjs), plus the strict runtime reload regression. Its native store is a test fixture outside FalconDeck's state file; production history ownership remains unchanged.

## Remaining qualification limits

Phase 4 must verify relay reconnect/pruning with pending approvals and real desktop/mobile/remote interaction flows. Optional native session import is deferred. Image block preservation is covered by a production-content test; model image understanding is not qualified. Delegation cancellation was not exercised by the terminal cancellation test.

Executor failure paths without the verified stderr marker still need an upstream explicit JSON-RPC failure or a separately demonstrated adapter fix. Serialization prevents concurrent provider-error attribution within a Hermes runtime; the HTTP 400 qualification does not establish that all Hermes executor failures are covered. Hermes edit modes remain file-edit policies, not filesystem sandboxes or unrestricted shell modes.
