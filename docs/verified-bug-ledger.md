# Verified Bug Ledger

This ledger supports the long-running goal to find and fix 100 verified FalconDeck bugs or concrete correctness issues. An item is counted only after its trigger is reproduced, its root cause is established, and its fix passes a focused regression check. Product and test-infrastructure issues are identified separately.

## Progress

- Verified and fixed: 33 / 100
- Product defects: 31
- Test-infrastructure defects: 2

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

## Pending Verification

None yet.
