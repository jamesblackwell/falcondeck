# Hermes ACP qualification

Recorded on 2026-10-06 for Phases 0 and 1 of [the integration plan](HERMES-INTEGRATION-PLAN.md). Hermes is discoverable through native ACP. This qualifies the initial integration; it does not complete the later instruction, connector, or cross-client work.

## Baselines and configuration

| Baseline | Executable / source | Version |
| --- | --- | --- |
| Existing installation | `~/.local/bin/hermes` → `~/.hermes/hermes-agent/venv/bin/hermes`; source `5a3317693c6ddd84834c4684eb6929ade20f0962` | `hermes acp --version`: `0.14.0` |
| Disposable current source | Separate editable installation of [revision `1d6b2786e2b2de70a967c66b6a14e2b83bab30e7`](https://github.com/NousResearch/hermes-agent/tree/1d6b2786e2b2de70a967c66b6a14e2b83bab30e7), using Python 3.14.6 and the source's ACP extra | `hermes-acp --version`: `git.1d6b278`; initialization's `agentInfo.version` says `unknown` |

Both use `agent-client-protocol` 0.9.0 and negotiate ACP protocol 1. Both pass `--check`. The existing source checkout was clean and was **not upgraded**. The current source ran in a temporary virtual environment with a private temporary `HERMES_HOME`, seeded from the existing model configuration. The existing installation used its normal `~/.hermes` profile. Credentials were never added to repository files. Existing Hermes `.env`, `config.yaml`, and FalconDeck `providers.json` were checked by digest before and after qualification.

The configured default `openai-codex:gpt-5.4` is advertised but the account rejects it with HTTP 400. Live qualification selected the advertised, working `openai-codex:gpt-5.6-luna` **per session**, without changing the saved default. This distinction matters: initialization and model discovery alone do not establish that the configured model works.

All model/tool requests were diagnostic prompts in disposable project folders. For the older installation's edit test the folder was under `/tmp`: its write tool treats macOS's `/private/var/folders` temporary directories as sensitive system paths. The current source accepted the normal macOS temporary directory. Before replacing an existing file, the edit test read its full content to satisfy Hermes' overwrite protection.

## Results

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

## Remaining qualification limits

Later phases must verify instruction delivery, connector execution and isolation, compression, two simultaneous threads, cross-client approval/reconnect behavior, image understanding, and import/discovery of existing native sessions. Hermes edit modes are not filesystem sandbox or shell permission modes.

Concurrent provider errors without a session identifier remain an upstream protocol limitation: the daemon deliberately does not attach one shared stderr line to multiple sessions. Executor failure paths without the verified stderr marker also need an upstream explicit JSON-RPC failure or a separately demonstrated adapter fix. The HTTP 400 tests do not imply that all Hermes error paths are covered. Detection and setup are ready; these remaining limits are not a claim of completed first-class support.
