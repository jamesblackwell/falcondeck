# Hermes ACP qualification

Recorded on 2026-10-06 for Phases 0–2 of [the integration plan](HERMES-INTEGRATION-PLAN.md). Hermes is discoverable through native ACP. The historical Phase 0/1 matrix below is followed by Phase 2 runtime and interaction results. Connector identity and full cross-client release qualification remain in Phases 3 and 4.

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

## Remaining qualification limits

Phases 3 and 4 must verify per-thread connector identity and same-named connector isolation, warm runtime retirement and full daemon restart recovery, long replay deduplication, import/discovery of existing native sessions, relay reconnect/pruning with pending approvals, and real desktop/mobile/remote interaction flows. Basic compressed-session reload above does not complete those phases. Image block preservation is covered by a production-content test; model image understanding is not qualified. Delegation cancellation was not exercised by the terminal cancellation test.

Executor failure paths without the verified stderr marker still need an upstream explicit JSON-RPC failure or a separately demonstrated adapter fix. Serialization prevents concurrent provider-error attribution within a Hermes runtime; the HTTP 400 qualification does not establish that all Hermes executor failures are covered. Hermes edit modes remain file-edit policies, not filesystem sandboxes or unrestricted shell modes.
