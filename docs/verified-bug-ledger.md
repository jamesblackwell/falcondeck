# Verified Bug Ledger

This ledger supports the long-running goal to find and fix 100 verified FalconDeck bugs or concrete correctness issues. An item is counted only after its trigger is reproduced, its root cause is established, and its fix passes a focused regression check. Product and test-infrastructure issues are identified separately.

## Progress

- Verified and fixed: 71 / 100
- Product defects: 68
- Test-infrastructure defects: 3

## Verification Standard

Each entry records:

1. The exact failing test, command, runtime reproduction, or browser/native QA.
2. Root-cause evidence from the actual code path.
3. The scoped fix.
4. The passing regression command or documented QA.
5. The autoreview result for the fix commit containing the item.

## Verified Fixes

### 001 — Client-core normalization test breaks the root typecheck

- Kind: Test infrastructure
- Reproduction: `npm run typecheck` fails with TS18048 at `packages/client-core/src/normalization.test.ts:27-28`.
- Root cause: `WorkspaceAgentSummary.capabilities` is intentionally optional at the wire boundary, but the new regression test dereferenced it directly even though it was testing the normalizer's runtime guarantee.
- Fix: Assert the normalized capability object with `toMatchObject`, preserving both the wire type and the runtime assertion.
- Verification: `npm run typecheck` passes across all workspaces; `npm run test --workspace packages/client-core -- --run src/normalization.test.ts` passes all 44 tests.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings.

### 002 — DA1 PTY integration test depends on shell-specific echo rendering

- Kind: Test infrastructure
- Reproduction: `cargo test --workspace` fails in `terminal::tests::da1_query_is_answered_at_the_pty_boundary`; the captured output contains the daemon reply as `\u{7}1;2c` instead of the expected `^[[?1;2c`.
- Root cause: The test sent the reply to an interactive prompt and assumed the tty would caret-echo the escape bytes. The active shell line editor consumed the escape prefix and rendered a bell instead, even though the captured remainder proved that the daemon wrote the response.
- Fix: Keep the shell command in raw mode long enough to read all seven reply bytes and assert their hexadecimal representation directly.
- Verification: `cargo test -p falcondeck-daemon terminal::tests::da1_query_is_answered_at_the_pty_boundary -- --exact` passes and directly observes `1b 5b 3f 31 3b 32 63`.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings.

### 003 — Durable daemon-event snapshots put their discriminator after the large payload

- Kind: Product defect
- Reproduction: The new `durable_event_prefix_identifies_the_envelope_before_the_event_payload` test decrypted a real durable event and failed because its plaintext began `{"event":...,"kind":"daemon-event"}`.
- Root cause: `serde_json::json!` stores object members in map order, so `event` serialized before `kind`. The clients' bounded 2 KiB replay fast path therefore could not identify a multi-megabyte snapshot without parsing the whole event.
- Fix: Serialize a typed `RemoteDaemonEventEnvelope` whose declared field order is `kind`, then `event`.
- Verification: `cargo test -p falcondeck-daemon durable_event -- --nocapture` passes both durable-event tests and decrypts the envelope to assert its prefix.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 004 — Replay snapshot detection mistakes nested provider data for a snapshot event

- Kind: Product defect
- Reproduction: A regression test passed a durable `conversation-item-added` event whose unsupported provider payload contained `{ "type": "snapshot" }`; `encryptedPayloadIsSoleSnapshotEvent` incorrectly returned `true`.
- Root cause: The optimization searched the first 2 KiB for independent `kind` and `type` substrings instead of inspecting the tagged union at the daemon event's exact structural position. During recovery this could skip a real conversation item and advance the replay cursor.
- Fix: Anchor detection to the ordered single-event envelope and inspect only the leading `type` discriminator of its nested `UnifiedEvent`.
- Verification: `npm run test --workspace packages/client-core -- --run src/remote-events.test.ts` passes all 19 tests, including snapshot, batch, and nested-provider cases.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 005 — Images with a known extension and blank browser MIME type cannot be attached safely

- Kind: Product defect
- Reproduction: An untyped `File` named `photo.png` was rejected by `filesToImageInputs`; after allowing it into preparation, the smaller-original optimization restored the blank-MIME file instead of the generated JPEG. The public-entry regression test observed `mime_type: ""` and `photo.png` rather than a safe JPEG.
- Root cause: Browsers may leave `File.type` empty when the OS has no MIME mapping, but the intake path treated every blank MIME as non-image while `imageNeedsPrepare` treated it as already provider-safe. A second guard preferred any smaller original regardless of its media type.
- Fix: Accept blank MIME only for a known image filename extension, always prepare media types outside the provider-safe set, and only prefer a smaller original when its media type is provider-safe.
- Verification: `npm run test --workspace packages/client-core -- --run src/image-attachment-budget.test.ts src/image-prepare.test.ts` passes 16 tests, including rasterization through the public attachment entry point.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 006 — Equal-timestamp waiting updates can resurrect a settled thread

- Kind: Product defect
- Reproduction: A focused reducer test applied `idle` and then `waiting_for_input` summaries with the same `updated_at`; the final thread incorrectly became waiting again.
- Root cause: The stale-summary guard rejected only equal-timestamp `running` updates after a terminal state. Delayed `waiting_for_input` updates are equally nonterminal, while genuine new turns carry a newer timestamp.
- Fix: Reject every equal-timestamp terminal-to-nonterminal regression, while preserving same-timestamp transitions between active states.
- Verification: `npm run test --workspace packages/client-core -- --run src/thread-status-events.test.ts` passes all 9 status-ordering tests.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 007 — Selecting a slash suggestion with the caret mid-token leaves a suffix behind

- Kind: Product defect
- Reproduction: For `/linting now` with the caret after `/lin`, `activeSlashQuery` returned `rangeEnd: 4` rather than 8; `/api/provider` at the same caret position was also treated as an active command query.
- Root cause: The active-query range stopped at the caret rather than scanning to the end of the slash token, and path rejection inspected only characters before the caret.
- Fix: Validate command characters, scan the replacement range through the token suffix, and reject a slash later in the same token.
- Verification: `npm run test --workspace packages/client-core -- --run src/skills.test.ts` passes all 12 tests, including mid-token replacement and path rejection.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 008 — Composer suggestion truncation can create a replacement character

- Kind: Product defect
- Reproduction: A 512-character prompt ending at an emoji boundary was truncated with `String.slice`; the resulting prompt ended in a lone surrogate rendered as `�`.
- Root cause: Prompt truncation counted UTF-16 code units even though the adjacent label/description logic and the published limit operate on Unicode characters.
- Fix: Truncate prompts from `Array.from(value)` so surrogate pairs remain intact.
- Verification: `npm run test --workspace packages/client-core -- --run src/composer-suggestions.test.ts` passes all 12 tests, including the exact 512-character emoji boundary.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 009 — Interactive requests from different workspaces overwrite each other

- Kind: Product defect
- Reproduction: Two pending requests with the same provider-native `request_id` but different `workspace_id` values produced a queue of length one.
- Root cause: The daemon's identity is `(workspace_id, request_id)`, but `orderedInteractiveRequestQueue` deduplicated globally by request ID. Two connected workspaces or hosts may legitimately reuse that ID.
- Fix: Use the workspace/request pair as the deduplication key while retaining last-update-wins semantics within one workspace.
- Verification: `npm run test --workspace packages/client-core -- --run src/interactive-request.test.ts` passes all 19 request ordering and deduplication tests.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 010 — Uppercase localhost file URLs are rejected

- Kind: Product defect
- Reproduction: `decodeFileUrl("file://LOCALHOST/Users/james/report.txt")` returned `null`.
- Root cause: The decoder compared the authority case-sensitively even though URL hostnames are case-insensitive.
- Fix: Normalize the extracted host to lowercase before applying the localhost allowlist.
- Verification: `npm run test --workspace packages/client-core -- --run src/local-path.test.ts` passes all 13 path and URL cases.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 011 — Directive-shaped examples inside Markdown code blocks execute as agent actions

- Kind: Product defect
- Reproduction: A fenced block containing `::git-push{branch=example}` was split into markdown/directive/markdown, removed by the strip helper, and rewritten as an action by the copy helper. An indented Markdown code line parsed as a directive too.
- Root cause: Each line was parsed independently after trimming whitespace, with no Markdown fence state or column-zero transport requirement.
- Fix: Classify lines with fenced-code state, protect opening/closing/interior fence lines across all consumers, and require transport directives at column zero.
- Verification: `npm run test --workspace packages/client-core -- --run src/agent-directive.test.ts` passes all 6 parsing, streaming, strip, copy, fence, and indentation tests.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 012 — Remote hosts keep a bootstrap retry timer after encryption is already available

- Kind: Product defect
- Reproduction: A `RemoteHostClient` created with a persisted data key still had a live `bootstrapRetryInterval` immediately after opening. A client that installed a key from replay kept the same interval too.
- Root cause: `startBootstrapRecovery` always allocated the 30-second interval, and successful session bootstrap never cleared it. The callback became a permanent no-op but continued waking for the lifetime of every encrypted connection.
- Fix: Do not start bootstrap recovery when session crypto already exists, and clear the retry interval as soon as replay installs the data key.
- Verification: `npm run test --workspace packages/client-core -- --run src/remote-host-client.test.ts` passes both persisted-key and bootstrap-replay timer assertions.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 013 — Live remote events can be delivered concurrently and out of order

- Kind: Product defect
- Reproduction: The first encrypted realtime event entered an asynchronous `onEvents` callback and remained blocked; the second event entered the callback before the first settled.
- Root cause: The encrypted-ephemeral chain awaited decryption but `handleEncryptedEphemeral` discarded the promise returned by `onEvents`, so the chain considered delivery complete too early.
- Fix: Await the host event callback as part of the ephemeral delivery chain.
- Verification: The focused remote-host test holds event 1, proves event 2 cannot start during that interval, releases event 1, and then observes delivery order `[1, 2]`.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 014 — An encrypted RPC can resolve successfully after its connection has closed

- Kind: Product defect
- Reproduction: A valid encrypted `rpc-result` was received, the socket closed while Web Crypto was decrypting it, and the caller still resolved with the stale result instead of receiving `Relay connection closed`.
- Root cause: `resolveRpc` removed the request from `pendingRpc` before awaiting decryption. Reconnect therefore could not reject it, and no generation/session check guarded the later resolution.
- Fix: Keep the request registered until decryption and generation validation finish; settle it only if it is still pending on the same connection and crypto state.
- Verification: The focused test closes the exact socket after dispatching an encrypted result and now observes rejection with `Relay connection closed`.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 015 — Replay received after a quick remote-host restart can remain stranded forever

- Kind: Product defect
- Reproduction: Event 1 was waiting in the host's asynchronous apply callback when the client stopped and restarted. Event 2 arrived on the new socket, but after event 1 settled the callback sequence remained `[1]`; event 2 was never flushed.
- Root cause: The new flush returned while the old generation owned the global `flushInProgress` flag. The old flush's `finally` released the flag but only restarted pending work when its own generation was still current. It could also persist its stale cursor after the awaited callback.
- Fix: Recheck generation immediately after asynchronous event application, and when any old flush releases the flag, start pending work for the currently running generation.
- Verification: The focused restart regression now observes ordered callbacks `[1, 2]` without requiring a third relay update to kick the queue.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 016 — A stopped desktop host can be resurrected by an old snapshot response

- Kind: Product defect
- Reproduction: `HostConnection.refresh()` was left pending, `stop()` cleared the host state, and then the old snapshot RPC resolved; `connection.snapshot` became non-null again.
- Root cause: Snapshot completion had no lifecycle/client identity check and unconditionally applied results and toggled barrier state after asynchronous RPC completion.
- Fix: Version the host lifecycle and apply refresh success, failure, and barrier cleanup only when both the generation and client instance remain current.
- Verification: `npm run test --workspace apps/desktop -- --run src/hosts.test.ts` passes the deferred-RPC stop regression and existing extension refresh tests.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 017 — A combined thinking-display update can discard every daemon-owned preference

- Kind: Product defect
- Reproduction: Splitting `{ notifications: { enabled: false }, conversation: { thinking_display: "preview" } }` returned `daemonPayload: null`, so the notification change was never sent.
- Root cause: `splitPreferencesUpdate` decided whether a daemon payload existed by inspecting only the remaining conversation fields after extracting the device-local field. It ignored top-level notifications, utility-model, ordering, and color updates.
- Fix: Build the daemon payload from every top-level field, replace or remove only its conversation member, and decide whether it is empty afterward.
- Verification: `npm run test --workspace apps/desktop -- --run src/preferences.test.ts` passes the exact mixed-update regression.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 018 — A removed default agent remains selected for new threads

- Kind: Product defect
- Reproduction: A workspace advertising only Claude but retaining `default_provider: "removed-agent"` returned `removed-agent` from `defaultProvider`.
- Root cause: The helper trusted any nonblank stored default without checking the workspace's current agent catalog. Removing or renaming an ACP agent therefore left the new-thread composer pointed at an unavailable provider.
- Fix: Honor the declared default when no catalog exists or it is still advertised; otherwise fall back to the first live workspace agent.
- Verification: `npm run test --workspace packages/client-core -- --run src/collaboration.test.ts` passes the removed-agent regression and existing open-provider behavior.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 019 — Empty-value contenteditable editors trigger global typing shortcuts

- Kind: Product defect
- Reproduction: A child of `<div contenteditable>` (the HTML empty-attribute spelling) returned `false` from `isEditableTarget`. Typing the bare `?` shortcut there could open the shortcut panel instead of inserting text.
- Root cause: The selector recognized only the literal attribute value `contenteditable="true"`, although empty and `plaintext-only` values also enable editing.
- Fix: Detect the nearest contenteditable host by attribute presence, excluding only an explicit `false`, while preserving native input/textarea/select handling.
- Verification: `npm run test --workspace apps/desktop -- --run src/shortcuts.test.ts` passes enabled-empty, explicit-false, and non-editor assertions.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 020 — Daemon API route identifiers are interpolated without path encoding

- Kind: Product defect
- Reproduction: Sending a turn for workspace `workspace/with space` and thread `thread?#fragment` requested `/workspaces/workspace/with space/threads/thread?#fragment/turns`, changing both route segmentation and URL query/fragment semantics.
- Root cause: Older and newer client methods were inconsistent: some used `encodeURIComponent` for each identifier while thread, goal, git, file, and interactive-request routes interpolated raw IDs.
- Fix: Encode every workspace, thread, and request identifier as an individual URL path segment across the daemon client.
- Verification: `npm run test --workspace packages/client-core -- --run src/daemon-client.test.ts` passes the special-character route assertion and all existing endpoint-shape tests; a source scan finds no remaining raw identifier interpolation in these routes.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 021 — Malformed stored remote-host credentials can crash desktop startup

- Kind: Product defect
- Reproduction: Starting a `HostConnection` from an otherwise valid persisted host whose secret key contained invalid Base64 threw `InvalidCharacterError` synchronously.
- Root cause: Local storage is an untrusted recovery boundary, but `HostConnection.start` constructed and started `RemoteHostClient` without catching key restoration or URL setup failures.
- Fix: Contain synchronous client initialization failures, reset transient host state, mark the server as needing repair, persist that state, and expose actionable error copy.
- Verification: `npm run test --workspace apps/desktop -- --run src/hosts.test.ts` passes the malformed-credential startup regression and preserves the host as paired/repairable rather than throwing.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 022 — Carriage returns bypass the single-line composer-suggestion contract

- Kind: Product defect
- Reproduction: `cargo test -p falcondeck-core --test composer_suggestions description_rejects_every_line_break -- --exact --nocapture` failed because `"first\rsecond"` was accepted while the equivalent LF description was rejected.
- Root cause: `ComposerSuggestionSet::validate` checked only `\n`, despite the published extension contract requiring a single-line description and CR being a line break on its own and in CRLF input.
- Fix: Reject both CR and LF at the Rust-owned daemon protocol boundary.
- Verification: The focused regression passes; `cargo test -p falcondeck-core -p falcondeck-daemon` also passes the complete core and daemon suites.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.82.

### 023 — A provider citation ID can duplicate an already-streamed citation

- Kind: Product defect
- Reproduction: `cargo test -p falcondeck-core --test citation provider_id_enrichment_does_not_duplicate_a_synthetic_citation -- --exact --nocapture` produced two citations for the same kind and URL after the first partial event received `answer-3:citation:0` and the enriched event supplied `provider-citation-1`.
- Root cause: Citation identity gives two real provider IDs priority, but FalconDeck assigned its synthetic stable ID before the next delta arrived. The unequal synthetic/provider IDs then prevented the legacy URL/locator identity fallback from running.
- Fix: Recognize only FalconDeck-generated numeric citation IDs during merge and allow those entries to match a later real provider ID through the existing legacy source identity, while keeping the first client-visible ID stable.
- Verification: All five citation integration tests pass; the full core and daemon test command passes.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.82.

### 024 — A complete short DA1 terminal query at a batch boundary panics the daemon task

- Kind: Product defect
- Reproduction: Adding the short `ESC [ c` query as a complete output batch to `terminal::tests::da1_filter_strips_complete_queries` panicked at `terminal.rs:83` with `attempt to subtract with overflow`.
- Root cause: After stripping the complete three-byte query, the trailing-partial scan also classified that full query as a prefix of itself and tried to truncate three bytes from an empty output buffer.
- Fix: Treat a suffix as partial only when it is strictly shorter than the matching query pattern.
- Verification: `cargo test -p falcondeck-daemon terminal::tests::da1_filter_strips_complete_queries --lib -- --exact` passes both complete DA1 spellings; the full daemon suite passes 862 unit tests, 2 intentional ignores, and every integration test.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.82.

### 025 — Utility-model patches keep whitespace inside provider IDs

- Kind: Product defect
- Reproduction: `cargo test -p falcondeck-daemon app::storage::tests::utility_model_patch_normalizes_provider_ids_before_use -- --exact --nocapture` left provider order as `[" codex ", "codex"]` and made the patched model unreachable via the real `codex` provider.
- Root cause: Persisted preference loading trims provider IDs, but the live patch path only tested a trimmed view for emptiness and stored the original value. The running daemon therefore behaved differently until restart and failed to deduplicate equivalent IDs.
- Fix: Normalize provider IDs before filtering and deduplicating both the order and per-provider model choices.
- Verification: The focused storage regression and the complete core/daemon test suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.82.

### 026 — Prefix-related user prompts disappear from the thread search index

- Kind: Product defect
- Reproduction: `cargo test -p falcondeck-daemon app::thread_search::tests::keeps_distinct_consecutive_prompts_when_one_is_a_prefix -- --exact --nocapture` indexed only `fix login` and discarded the subsequent real prompt `fix login and logout`.
- Root cause: Transcript deduplication treated either adjacent string being a prefix of the other as proof that Codex had recorded the same turn twice. Legitimate follow-ups commonly extend or shorten the previous request.
- Fix: Deduplicate only exact adjacent normalized messages; distinct prefix-related prompts are retained.
- Verification: All 11 thread-search tests and the full daemon suite pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.82.

### 027 — Unicode lowercase expansion can push the search hit out of its own snippet

- Kind: Product defect
- Reproduction: `cargo test -p falcondeck-daemon app::thread_search::tests::snippet_centres_on_a_hit_after_expanding_unicode_lowercase -- --exact --nocapture` returned a 180-character snippet that omitted `needle`, even though `needle` was the matched query.
- Root cause: Search offsets are byte positions in a lowercased string, while snippet slicing used byte boundaries from the original string. Characters such as `İ` expand when lowercased, so the offset can exceed the original byte length and fall back to the start of the message.
- Fix: Map the lowercased byte offset back through each original character's actual lowercase encoding before selecting the character window.
- Verification: The focused Unicode regression, all thread-search tests, and the complete core/daemon test suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.82.

### 028 — Expired idempotency records replay indefinitely while control is idle

- Kind: Product defect
- Reproduction: `control::tests::expired_idempotency_record_does_not_replay_while_the_service_is_idle` backdated a live successful create record beyond the documented 24-hour TTL; a different create using that key still returned `idempotency_conflict`.
- Root cause: TTL compaction ran only during restore or a later mutation. The replay lookup itself ignored `created_at`, so an idle service could keep an expired key active for an unbounded time.
- Fix: Apply the same 24-hour age condition during idempotency lookup; the following successful mutation removes the stale record through normal compaction.
- Verification: All 29 control-service tests, 868 daemon unit tests with 2 intentional ignores, and the control API/MCP/scheduler integration suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 029 — Concurrent identical idempotent creates can both execute

- Kind: Product defect
- Reproduction: `control::tests::concurrent_idempotent_creates_execute_only_once` launched two identical creates together; both succeeded with different automation IDs and two definitions were stored.
- Root cause: Replay lookup, operation mutation, audit persistence, and idempotency-record persistence were separate critical sections. Both calls could observe a missing record before the first published it.
- Fix: Serialize keyed control executions across lookup, side effect, and record publication; non-idempotent operations remain independent.
- Verification: The concurrent regression now returns the same automation ID to both callers and stores one definition; the complete daemon and control integration suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 030 — HTTP and remote callers bypass the idempotency-key size contract

- Kind: Product defect
- Reproduction: `control::tests::execute_rejects_idempotency_keys_outside_the_public_bounds` showed that both a five-character key and a 129-character key executed successfully.
- Root cause: The MCP tool schema advertised and enforced 8–128 characters, but `ControlService::execute` trusted every other caller and persisted arbitrary key sizes. Repeated large keys could also push the control store beyond its own load limit.
- Fix: Enforce the published Unicode-character bound in the authoritative service before lookup or mutation.
- Verification: The focused boundary test and all daemon/control integration suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 031 — Garbage suffixes are accepted as named cron fields

- Kind: Product defect
- Reproduction: `control::automations::tests::rejects_garbage_suffixes_on_named_cron_values` showed that `monkey` parsed as Monday and `marching` parsed as March.
- Root cause: Named values used `starts_with` against three-letter abbreviations, so every arbitrary token beginning with a valid abbreviation became a valid schedule.
- Fix: Accept only the exact standard abbreviation or exact full month/weekday name.
- Verification: All 15 automation-schedule tests pass, including abbreviations, full names, invalid suffixes, DST, and DOM/DOW behavior; the broader daemon/control suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 032 — A large cron step panics on integer overflow

- Kind: Product defect
- Reproduction: `control::automations::tests::oversized_cron_steps_do_not_overflow` parsed `1/4294967295` and panicked at `automations.rs:125` with `attempt to add with overflow`.
- Root cause: The cron value expansion loop used unchecked `u32` addition even though the step is user-controlled and may be any nonzero `u32`.
- Fix: Stop expansion when the next step cannot be represented; the sparse schedule correctly retains its starting value.
- Verification: The focused maximum-step regression, all automation tests, the daemon library suite, and all three control integration binaries pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 033 — Oversized interval values can hang schedule calculation forever

- Kind: Product defect
- Reproduction: `control::automations::tests::interval_larger_than_i64_does_not_wrap_to_a_one_second_schedule` with `every_seconds: u64::MAX` did not complete; the test process had to be terminated after the scheduler loop continued indefinitely.
- Root cause: The interval was cast from `u64::MAX` to `i64`, becoming `-1`. Each loop iteration then moved the candidate farther into the past instead of advancing beyond `after`.
- Fix: Perform interval arithmetic in `i128`, convert the final timestamp only after it is proven representable, and return `invalid_schedule` when the next occurrence is outside the supported time range.
- Verification: The formerly hung regression now returns immediately with an error; all schedule, daemon library, and control integration tests pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 034 — Terminal protocol pings never receive a pong

- Kind: Product defect
- Reproduction: The terminal WebSocket integration test sent `terminal_ping` after attachment and timed out after five seconds waiting for the documented `terminal_pong` response.
- Root cause: `TerminalManager::handle_client_frame` explicitly discarded `TerminalPing`, and the WebSocket loop had no connection-scoped reply path.
- Fix: Reply with `TerminalPong` directly on the requesting WebSocket while continuing to route input and resize frames through the session manager.
- Verification: `cargo test -p falcondeck-daemon --test terminal_api` passes the attach, ping/pong, input/output, close, exit, and removal round trip.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 035 — Output committed during terminal attachment can be lost permanently

- Kind: Product defect
- Reproduction: `terminal::tests::attach_cannot_lose_output_between_replay_and_live_registration` committed a chunk after replay was captured but before the client sender was registered; the receiver got neither replay nor live output.
- Root cause: `attach` released the scrollback lock before adding the client to the live sender list, leaving an explicit handoff gap.
- Fix: Hold the scrollback lock through snapshot/replay enqueue and live-client registration, then release it before output can resume.
- Verification: The deterministic interleaving regression and all 14 terminal unit tests pass; the full daemon library passes 873 tests with 2 intentional ignores.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 036 — Natural terminal exit leaves a stale PID armed for delayed SIGKILL

- Kind: Product defect
- Reproduction: `terminal::tests::natural_exit_clears_the_pid_before_delayed_cleanup` retained the session object after a normal shell exit and found its reaped process ID still present after `TerminalExited`.
- Root cause: Only the delayed force-kill path consumed `session.pid`; the child wait/reap path removed the session without clearing it. A quickly reused process-group ID could therefore receive the later SIGKILL.
- Fix: Consume the PID immediately after `child.wait()` returns, before any output-drain wait or exit broadcast.
- Verification: The focused natural-exit regression, all terminal tests, and the daemon library suite pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 037 — Terminal EOF can drop the final partial escape sequence

- Kind: Product defect
- Reproduction: A real PTY command disabled echo, replaced the shell with `/usr/bin/printf`, and ended its only output with `FINAL-BYTES ESC`; `terminal::tests::exit_flushes_the_last_partial_escape_before_the_exit_frame` received `FINAL-BYTES` but not the final escape before `TerminalExited`.
- Root cause: The DA1 filter correctly withheld a possible partial query between batches, but discarded that pending suffix when the raw reader reached EOF. The independent exit watcher could also clear client channels before the async output pump finished draining.
- Fix: Flush the filter's pending bytes at EOF and make the exit watcher wait for the output pump's completion signal before broadcasting exit and clearing clients.
- Verification: The focused real-PTY regression now observes the exact trailing escape before the exit frame; all terminal and daemon tests pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 038 — A stalled terminal socket can grow unbounded daemon queues

- Kind: Product defect
- Reproduction: `terminal::tests::a_stalled_terminal_client_cannot_build_an_unbounded_output_queue` attached a receiver without draining it, committed 1,000 frames, and found the client still registered with every frame queued.
- Root cause: Both the blocking-reader-to-async-pump channel and every per-client channel were unbounded. Scrollback bytes were capped, but slow clients or a starved runtime could continue accumulating separate output copies indefinitely; tiny chunks also evaded any scrollback allocation-count bound.
- Fix: Add bounded raw and client channels with PTY backpressure/slow-client disconnect, cap retained scrollback by both bytes and chunk count, and leave reconnect to recover from bounded replay.
- Verification: The stalled-client regression, a new tiny-chunk retention bound test, all 14 terminal unit tests, the complete daemon library, and the terminal WebSocket integration test pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.78.

### 039 — Lowercase Bearer authentication schemes are rejected

- Kind: Product defect
- Reproduction: `api::tests::bearer_auth_scheme_is_case_insensitive` supplied the valid HTTP authorization value `bearer client-token`; `auth_token` returned `missing bearer token`.
- Root cause: The parser used a case-sensitive `strip_prefix("Bearer ")` even though HTTP authentication schemes are case-insensitive.
- Fix: Split the scheme from its credentials and compare the scheme with `eq_ignore_ascii_case` while retaining the nonblank-token check.
- Verification: The focused authentication regression and the full relay unit/API suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.72.

### 040 — A byte-heavy replay disconnects after enqueueing only a prefix

- Kind: Product defect
- Reproduction: `app::tests::byte_heavy_replay_uses_snapshot_recovery_before_peer_queue_overflow` built 100 retained 450 KiB encrypted updates. The relay produced a replay batch larger than its peer queue budget instead of a recovery marker.
- Root cause: `send_sync_to_peer` enqueues every replay chunk from inside the socket's inbound handler, but that same socket cannot drain its outbound receiver until the handler returns. Per-chunk queue admission therefore failed partway through a large-but-count-valid replay and repeated on every reconnect.
- Fix: Measure the serialized replay batch before enqueueing it and emit one `history_truncated` snapshot-recovery marker when the batch cannot fit atomically in the peer byte budget.
- Verification: The focused 45 MiB aggregate replay regression and the full relay unit/API suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.72.

### 041 — A future replay cursor can suppress all later updates indefinitely

- Kind: Product defect
- Reproduction: `app::tests::future_replay_cursor_requires_snapshot_recovery` gave a session with `next_seq = 7` the cursors `7` and `u64::MAX`; both were reported as intact even though the highest valid acknowledgement was 6.
- Root cause: Truncation detection considered only server-pruned prefixes and never detected a client cursor at or beyond the next sequence. Such a client would keep requesting updates after a point the server had never reached.
- Fix: Treat `after_seq >= next_seq` as an invalid replay base that requires authoritative snapshot recovery, while preserving `next_seq - 1` as the valid caught-up cursor.
- Verification: The focused future-cursor boundary regression and the full relay unit/API suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.72.

### 042 — Blank thread titles produce blank push-notification titles

- Kind: Product defect
- Reproduction: `app::tests::push_notifications_fall_back_for_blank_titles_and_trim_display_copy` passed a whitespace-only title and received `"   "` instead of the `FalconDeck` fallback; padded real titles were also displayed with their padding.
- Root cause: Push copy used any present `thread_title` verbatim without trimming or checking whether it contained displayable text.
- Fix: Trim optional titles, discard blank results, and then apply the product-name fallback.
- Verification: Both blank and padded title cases pass with the complete relay unit/API suites.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.72.

### 043 — Retrying an idempotent action appends duplicate durable status updates

- Kind: Product defect
- Reproduction: `idempotent_action_retry_does_not_append_a_duplicate_status_update` submitted the same device/key/type/payload twice. The action ID was correctly reused, but replay contained two identical status updates.
- Root cause: `submit_action` deduplicated the action record but unconditionally appended and persisted another `ActionStatus` update afterward, so request retries still mutated the replay stream and sequence counter.
- Fix: Append and persist the queued status only when the action record is newly created; retries may still run the no-op pending-dispatch pass so an earlier interrupted request can recover.
- Verification: The focused API regression observes one action and one status update; the full relay suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.72.

### 044 — Daemons can report relay-owned action states and trigger duplicate dispatch

- Kind: Product defect
- Reproduction: `daemon_cannot_report_relay_owned_action_states` sent `ActionUpdate { status: queued }` for an owned dispatched action. The relay accepted it and immediately issued another `ActionRequested` delivery.
- Root cause: The action-update handler accepted every enum value even though `Queued` and `Dispatched` are relay-owned delivery states; daemon implementations only own `Executing`, `Completed`, and `Failed`.
- Fix: Reject daemon updates to either relay-owned state before mutating or redispatching the action.
- Verification: The focused WebSocket regression now receives a structured error rather than a duplicate action request; the complete relay suites pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.72.

### 045 — Removed WebSocket peers retain their authenticated authority

- Kind: Product defect
- Reproduction: `unregistered_peers_cannot_keep_using_their_authenticated_role` unregistered a client and then successfully initiated an RPC with its old peer ID; an unregistered daemon could likewise append a durable encrypted update.
- Root cause: `handle_message` trusted the role captured when the socket was created but never proved that the peer was still registered or that its trusted-device record was still active. Revocation and buffered inbound frames could therefore cross after peer removal.
- Fix: Give each peer a message/removal mutex, re-check membership, role, and active device state after acquiring it, and make unregister wait for already-authorized handling to finish before returning.
- Verification: The focused state-level regression rejects both stale-client RPC and stale-daemon update paths; all relay unit/API tests pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.72.

### 046 — The relay accepts WebSocket frames that its peer queue cannot forward

- Kind: Product defect
- Reproduction: `app::tests::peer_queue_accepts_a_websocket_legal_single_message` constructed a 33 MiB server message, below the relay's documented 40 MiB WebSocket limit; the 32 MiB peer queue rejected it immediately.
- Root cause: Inbound frame admission and outbound per-peer byte admission used conflicting limits, making valid large encrypted image/RPC payloads disconnect their recipient.
- Fix: Share the 40 MiB transport constant with the API and give the peer queue one additional MiB for relay-added update metadata and envelope fields.
- Verification: The focused 33 MiB queue regression, the aggregate replay regression, the full relay suites, Clippy with warnings denied, and targeted rustfmt checks all pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.72.

### 047 — One remote-web tab overwrites another tab's resumable session

- Kind: Product defect
- Reproduction: `remote session secret persistence > lets two tabs resume different sessions without overwriting each other` persisted two valid sessions, restored the first tab's secrets, and received `null` because the second tab had replaced the one global metadata record.
- Root cause: Cryptographic secrets were intentionally tab-scoped, but the matching session metadata still occupied one shared `localStorage` key. Any live cursor write from either tab replaced the other tab's session ID and token.
- Fix: Store metadata under a session-scoped key selected by the tab's secret record, migrate the prior global format, and clear only the session owned by the resetting tab.
- Verification: `npm test --workspace falcondeck-remote-web -- --run src/lib/remoteAppUtils.test.ts` passes two-session resume and targeted-clear regressions; the full 105-test remote-web suite, typecheck, and lint pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 048 — Loading or clearing one session deletes another tab's warm snapshot

- Kind: Product defect
- Reproduction: `remote snapshot cache > does not delete a cache belonging to another session` persisted session 1's cache, attempted to load session 2, and found that the mismatch path had removed session 1's valid cache. Persisting session 2 also replaced session 1 outright.
- Root cause: Every session shared one snapshot key, and the loader classified a well-formed foreign-session record as corrupt instead of merely unrelated.
- Fix: Scope snapshot keys by session, migrate a matching legacy cache, preserve mismatched legacy data, and make both reset and fresh-pairing cleanup ownership-aware.
- Verification: The remote snapshot-cache tests pass mismatch preservation, two independent caches, targeted clearing, and null-session clearing without affecting another tab; all remote-web checks pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 049 — Pending durable actions from different remote sessions erase each other

- Kind: Product defect
- Reproduction: `pending action persistence > keeps durable action recovery isolated between sessions` stored `action-1` for session 1 and `action-2` for session 2; the prior global array could retain only the second write, so session 1 lost recovery of its accepted action.
- Root cause: Durable action IDs had no session ownership in browser storage, while resume polling always used the current session's credentials. Another tab could overwrite the array or poll and discard IDs it did not own.
- Fix: Persist and clear pending-action IDs under encoded session-scoped keys and thread the owning session through remember, forget, resume, reset, and pairing paths.
- Verification: The focused isolation and fresh-pairing regressions pass, as do the complete remote-web suite, typecheck, and lint.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 050 — Remote thread selection leaks across independently paired sessions

- Kind: Product defect
- Reproduction: `selection persistence > keeps selections isolated between paired sessions` wrote distinct workspace/thread selections for two sessions; the original single key returned only the last session's selection.
- Root cause: Selection persistence was global even though the workspace and thread identifiers belong to one daemon session. Parallel tabs therefore rewrote one another's reload destination.
- Fix: Scope selection reads, writes, migration, and reset cleanup to the active session ID.
- Verification: Selection round-trip, clearing, malformed-input, and two-session isolation tests pass with all remote-web checks.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 051 — A transient action-poll failure permanently forgets accepted work

- Kind: Product defect
- Reproduction: The fire-and-forget and awaited branches in `submitQueuedAction` unconditionally called `forgetPendingAction` for a poll rejection such as HTTP 503, even though `resumePendingActions` correctly retained the same transient failure. `pending action persistence > retains transient poll failures but forgets terminal outcomes` captures the required decision.
- Root cause: Initial polling and reload recovery used contradictory terminal-error rules. A brief relay/network failure after durable acceptance removed the only browser pointer to the eventual result.
- Fix: Centralize terminal classification and forget only 401/404/not-found/invalid-token outcomes; retain timeouts, aborts, 5xx responses, and network failures for reconnect recovery.
- Verification: The focused terminal/transient regression and existing resume tests pass; all 105 remote-web tests pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 052 — Corrupt pending-action storage can launch an unbounded polling storm

- Kind: Product defect
- Reproduction: `pending action persistence > deduplicates, rejects blank ids, and bounds corrupt persisted input` placed blanks, duplicates, and more than the allowed number of IDs directly into storage. The old loader returned every string, which the resume effect converted into one fetch loop and `AbortController` per unique value.
- Root cause: Browser storage is an untrusted recovery boundary, but the loader performed only an array/string type check and imposed no content, length, duplication, or count bound.
- Fix: Reject blank/padded/oversized IDs, deduplicate them, and retain at most the newest 256 recoverable actions on both read and write.
- Verification: The raw corrupt-storage regression returns 256 valid unique IDs, and the full remote-web suite, typecheck, and lint pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 053 — Chrome, Firefox, and Edge on iOS are labeled as Safari

- Kind: Product defect
- Reproduction: `deviceLabelForUserAgent > labels iOS browsers accurately` supplied real-form `CriOS`, `FxiOS`, and `EdgiOS` user-agent tokens; the original detector missed all three and fell through to `Safari on iPhone`.
- Root cause: Browser detection recognized only desktop tokens (`Chrome/`, `Firefox/`, and `Edg/`) while every iOS browser user agent also contains Safari's WebKit token.
- Fix: Recognize the three iOS-specific browser tokens before the Safari fallback and extract the pure user-agent classifier for deterministic tests.
- Verification: All three iOS browser cases and the complete remote-web suite pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.85.

### 054 — An empty extension catalog schedules a redundant asynchronous render

- Kind: Test infrastructure
- Reproduction: The complete remote-web suite passed but printed React `act(...)` warnings in five App tests. `Promise.allSettled([])` in `useExtensionApps` resolved on a later microtask and replaced an already-empty registration map with another empty map after each test's synchronous render.
- Root cause: The extension host took the asynchronous loader path even when no enabled extension had a frontend loader, creating a real no-op browser render outside the test boundary.
- Fix: Short-circuit the empty-candidate case, preserve the current empty map by identity, and still clear a previously populated map when the catalog becomes empty.
- Verification: `app-host.test.tsx` proves an empty catalog renders exactly once; all 4 extension-SDK tests and all 108 remote-web tests pass with no `act(...)` warnings.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.90.

### 055 — Homepage keyboard shortcuts unexpectedly navigate legal pages

- Kind: Product defect
- Reproduction: Browser QA opened `http://127.0.0.1:4175/privacy`, pressed bare `d`, and observed navigation to `https://github.com/jamesblackwell/falcondeck/releases`, even though the privacy page contains no shortcut badge or download interaction.
- Root cause: `App` installed the homepage's global `d`/`s` listener before routing to the Privacy or Terms component, so the legal pages inherited invisible navigation shortcuts.
- Fix: Compute the route before installing the hook and enable the shortcuts only on pages that render the homepage shortcut affordances.
- Verification: In-app browser QA confirms `d` leaves `/privacy` unchanged while `s` on `/` still navigates to the source repository; the site production build passes.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.90.

### 056 — iPadOS desktop-mode Safari is shown as macOS

- Kind: Product defect
- Reproduction: `deviceLabelForUserAgent > recognizes iPadOS when Safari requests the desktop site` passed the standard Macintosh-form iPadOS user agent with `platform: MacIntel` and five touch points; the device label was `Safari on macOS`.
- Root cause: Modern iPadOS can request a desktop user agent without the `iPad` token. The classifier inspected only the user-agent string and therefore could not distinguish it from a Mac.
- Fix: Include the platform and touch-point hints from `navigator` and apply the established `MacIntel` plus multi-touch iPadOS distinction before the macOS fallback.
- Verification: The focused regression returns `Safari on iPad`; all 74 remote-app utility tests and the 108-test remote-web suite pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.90.

### 057 — A synchronous Notification API exception escapes the preferences UI

- Kind: Product defect
- Reproduction: `RemotePreferencesModal > contains a notification API that throws synchronously` stubbed `Notification.requestPermission` to throw. The original click produced an unhandled rejection and never rendered the permission notice.
- Root cause: Calling `Notification.requestPermission().catch(...)` handled a rejected returned promise but not an exception thrown while evaluating the API call itself.
- Fix: Wrap both invocation and awaiting in `try/catch`, map either failure form to a denied result, and leave notification preference disabled with actionable status copy.
- Verification: All 11 preferences-modal tests and the complete warning-free remote-web suite pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.90.

### 058 — Key-pair migration deletes its only copy before tab storage succeeds

- Kind: Product defect
- Reproduction: `client key-pair persistence > keeps a valid legacy key when tab storage is temporarily unavailable` stored a valid legacy key, made `sessionStorage.setItem` throw `SecurityError`, and observed a newly generated key with the legacy copy deleted.
- Root cause: Migration removed the durable legacy entry before attempting the tab-scoped write; its broad catch then treated the storage exception like corrupt cryptographic material. The successful pairing path also performed an uncaught direct tab-storage write before adopting the claimed session.
- Fix: Write the tab-scoped copy first, delete the legacy copy only after success, contain storage failures while retaining the in-memory key, and route restore, claim, generation, and reset through the safe helpers.
- Verification: The blocked-storage regression preserves and restores the exact original key; all remote-web tests, typecheck, and lint pass.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings; overall patch assessment 0.90.

### 059 — Pairing adopts credentials that failed to reach secure storage

- Kind: Product defect
- Reproduction: A relay-store regression made the native keychain reject a client-token write; the original claim path still entered `connecting` with the new session instead of remaining disconnected.
- Root cause: The secure-storage helpers logged native write failures and resolved successfully, so pairing could not distinguish durable credential storage from a failed write.
- Fix: Re-throw secure-storage failures after logging them, and reset the relay store's data-key persistence memo when an asynchronous checkpoint fails so it remains retryable.
- Verification: The focused relay-store regression leaves both connection status and session unset; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 060 — Malformed version-matching mobile cache reaches session hydration

- Kind: Product defect
- Reproduction: A cache regression stored the current schema version with `snapshot.history.items: null`; the original loader returned the malformed object, which session hydration would later treat as an array.
- Root cause: Cache loading checked only the top-level schema version and trusted every nested collection and selection field.
- Fix: Validate the snapshot collections, recent IDs, selections, and each thread-history record before returning a cached session; discard invalid entries.
- Verification: The malformed cache is removed and returns `null`; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 061 — Retired WebSockets can mutate a replacement mobile session

- Kind: Product defect
- Reproduction: The relay integration test rotated from session 1 to session 2, then delivered a message through session 1's old socket; the original handler wrote session 1 presence into the live store.
- Root cause: The socket message callback remained callable after cleanup and did not verify that its captured session was still current.
- Fix: Reject messages when the effect is stale or its captured session ID no longer matches the store's active session.
- Verification: The delayed old-socket message leaves the replacement session's presence unchanged; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 062 — Delayed pushes from an old pairing can change the current selection

- Kind: Product defect
- Reproduction: A push-notification regression paired session 2, then delivered a session-1 notification containing a thread and workspace; the original handler accepted it and rewrote selection state.
- Root cause: Push handling validated the notification shape but ignored its optional session identity.
- Fix: When a notification carries `sessionId`, require it to equal the currently persisted relay session before applying navigation state.
- Verification: The stale notification returns `false` and does not update selection; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 063 — Automation refresh deduplication crosses mobile sessions

- Kind: Product defect
- Reproduction: An automation-store test started a list refresh in session 1, rotated to session 2, and refreshed again; the original global in-flight promise suppressed the second RPC and could later install session 1 data.
- Root cause: Refresh deduplication and response writes were not scoped to the relay session that issued the request.
- Fix: Associate the in-flight refresh with its session ID, allow a new session to start its own request, and commit loading, data, and error state only while that session remains active.
- Verification: Rotation issues two list RPCs and only session 2's response reaches the store; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 064 — Old-session automation detail responses enter the new session

- Kind: Product defect
- Reproduction: An automation detail read began in session 1, session 2 was adopted, and the old response resolved; the original store inserted the returned automation into session 2.
- Root cause: The detail read committed its response without comparing the current session to the request's captured session.
- Fix: Capture the relay session ID at request time and skip the store mutation after a rotation.
- Verification: The old read resolves to the caller but leaves the current store unchanged; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 065 — Old-session automation run history enters the new session

- Kind: Product defect
- Reproduction: A run-history load begun in session 1 resolved after session 2 was adopted; the original code stored the old run under the active automation.
- Root cause: Run-history response writes lacked a request-session ownership check.
- Fix: Apply returned run history only if the initiating relay session is still active.
- Verification: The delayed session-1 response leaves session 2's run list empty; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 066 — Old-session automation mutations overwrite current automation state

- Kind: Product defect
- Reproduction: An automation mutation was sent in session 1 and resolved after switching to session 2; the original store inserted the returned paused automation into the new session.
- Root cause: Mutation responses were unconditionally merged into the shared automation collection.
- Fix: Capture request-session ownership for automation mutations and suppress the state merge after a session change.
- Verification: The stale mutation response does not alter session 2's collection; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 067 — Corrupt cached automation run values violate the store contract

- Kind: Product defect
- Reproduction: Hydration loaded a cache whose `runsByAutomation` value was a string; the original store exposed the string where consumers call array operations such as `.map`.
- Root cause: The cache boundary defaulted a missing top-level map but never validated individual map values.
- Fix: Normalize cached run history to a record containing only array-valued entries.
- Verification: The corrupt value hydrates as an empty run array and all automation-store regressions pass within the 948-test mobile suite.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 068 — Rapid repeated suggestion taps submit duplicate mobile turns

- Kind: Product defect
- Reproduction: A session-actions test invoked the same suggestion twice before React could paint its disabled state; the original code sent two `turn.start` RPCs.
- Root cause: The handler relied on asynchronous component state for exclusion and did not synchronously consult the pending-submission store.
- Fix: Check the request's submission key in the store before performing suggestion, override, compact, or regular turn work.
- Verification: Two immediate invocations produce exactly one RPC; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 069 — Native speech-start failures escape and leave the recorder starting

- Kind: Product defect
- Reproduction: The voice-recorder test rejected native speech permission; the original component emitted an unhandled rejection and continued to render the starting timer instead of an error.
- Root cause: The on-device start sequence awaited permission and native startup without a failure boundary.
- Fix: Catch the full native speech-start sequence, clear starting/finishing state, and surface the error in the recorder UI.
- Verification: The controlled native rejection is handled and renders the failure message without an unhandled promise; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 070 — Double stop taps transcribe the same mobile recording twice

- Kind: Product defect
- Reproduction: A voice-recorder test pressed stop twice before the first asynchronous recorder stop completed; the original code invoked native stop and transcription twice.
- Root cause: The visible finishing state did not synchronously guard the event handler between taps.
- Fix: Add an immediate ref-based finishing guard and reset it only when the stop fails or no speech is available for a retry.
- Verification: Two immediate stop events call the recorder stop exactly once; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

### 071 — Failed recorder cancellation leaks a rejection and active audio session

- Kind: Product defect
- Reproduction: A cancellation regression made the native recorder stop reject; the original fire-and-forget chain produced an unhandled rejection and never deactivated the audio session.
- Root cause: Cancellation attached only a success continuation, leaving both rejection handling and cleanup dependent on a successful stop.
- Fix: Use an async guarded cancellation path with error containment and unconditional audio-session deactivation in `finally`.
- Verification: The rejected stop is contained and audio deactivation still runs; the complete mobile suite passes all 948 tests.
- Autoreview: The initial pass found the new voice finishing guard could remain latched after a failed transcription; the failure was reproduced, fixed, and covered by a regression test. The required rerun was clean with no accepted/actionable findings; overall patch assessment 0.78.

## Pending Verification

None yet.
