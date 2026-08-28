# Conversation Quality Contract

FalconDeck's conversation surface is one product rendered by three clients:
desktop/macOS, remote web, and iOS. The daemon and native agent history remain
the source of truth. This document is the coverage contract used when changing
the shared protocol or any transcript renderer.

## Product bar

Every supported output must:

1. preserve provider order and stable identity while it streams;
2. expose an honest lifecycle (`pending`, `streaming`, `waiting`, `complete`,
   `interrupted`, or `error` as applicable);
3. remain readable and actionable before, during, and after streaming;
4. reconnect without duplication, loss, reordering, or stale-state rollback;
5. render with equivalent meaning on desktop, remote web, and iOS;
6. remain responsive in a 1,000-block heterogeneous thread; and
7. be keyboard and screen-reader operable without announcing every token.

On desktop startup, persisted session summaries are a distinct readiness
boundary from provider hydration. While summaries are loading, the app blocks
stale transcript and sidebar interaction. As soon as the daemon publishes a
complete persisted snapshot, shutdown-interrupted sessions are offered as one
stable batch; unrelated projects and connected remote hosts must not delay that
offer. Continue remains unavailable only while a project that owns one of those
sessions is reconnecting.

Provider capability differences may remove an unavailable action, but must not
silently change the meaning of content. Unsupported data renders through an
explicit, inspectable fallback rather than disappearing.

Copying provider-authored Markdown, including assistant responses and code-review
findings, uses the same agent-directive interpretation as the rendered transcript.
Complete directives become ordered, human-readable
`Agent action:` lines with their full attributes; raw `::directive{...}`
transport syntax never reaches the clipboard. An unfinished trailing directive
is omitted while streaming because it is not visible yet. Malformed terminal
text remains verbatim so unrecognized provider output is never silently lost.

Whole-conversation export is a deterministic, point-in-time Markdown snapshot.
Desktop and remote web expose **Download**; iOS exposes the native **Share**
sheet. All clients use the same `client-core` serializer so provider order,
lifecycle state, citations, plans, tool evidence, file changes, artifacts,
realtime events, unsupported fallbacks, and interactive requests cannot drift.
Serialization begins only when the action is invoked, never from the streaming
render path. If older authoritative history is not loaded, both the action's
accessible name and the document say so; partial history must never masquerade
as a complete export. Embedded image data URLs, unsafe provider references, and
interactive response secrets are not exported. Web clients revoke the temporary
object URL after download; native clients enforce the shared preparation cap,
use a unique cache directory, and remove the temporary file even on failure.
This follows the thread-level export pattern in [AI Elements
Conversation](https://elements.ai-sdk.dev/components/conversation) while
retaining FalconDeck's daemon-owned history and replay rules.

## Message and output matrix

`Required presentation` is the minimum behavior on every client. A checked row
still needs the scenario coverage below before it can be considered complete.

| Output                 | Required presentation                                                                | Required lifecycle and actions                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| User text              | Distinct user surface; streaming-safe Markdown is not required                       | copy; edit/resend or provider-capability explanation                                                          |
| User image/file        | Thumbnail or typed file row with name and safe open behavior                         | uploading, ready, rejected, unavailable                                                                       |
| Assistant text         | Streaming-safe GFM, code, tables, links, images, selection                           | pending, streaming, complete, interrupted, error; copy; retry/fork when supported                             |
| Agent action directive | Quiet in-order annotation with compact attributes; unknown directives remain visible | appears only after its complete line arrives; never leaked as protocol syntax or silently discarded           |
| Reasoning              | Restrained collapsed/preview/expanded treatment                                      | streaming and settled labels; duration when known                                                             |
| Tool call              | Typed renderer with generic fallback and inspectable detail                          | input streaming, approval requested/responded/denied, running, complete, interrupted, error                   |
| Read/search/list       | Quiet grouped activity with useful summary                                           | running and complete; expandable evidence                                                                     |
| Command/terminal       | Command, output, exit state, truncation and copy                                     | running, success, non-zero exit, interrupted                                                                  |
| File edit/diff         | File identity, structured diff and open-file action                                  | proposed/running/applied/error; large diff remains bounded                                                    |
| Test result            | Suite/test summary and failure detail                                                | running, passed, failed, interrupted                                                                          |
| Web search/source      | Search activity plus structured source list and safe links                           | searching, results, partial failure, error                                                                    |
| Image output/view      | Native image presentation with accessible description                                | loading, ready, unavailable, error                                                                            |
| Plan                   | Ordered steps and explanation                                                        | pending, in progress, completed, blocked, failed, and unknown provider states; updates preserve step identity |
| Approval               | One authoritative response surface with full request context                         | queued, active, allowed, always allowed, denied, expired                                                      |
| Code review            | Dedicated Markdown findings with review scope and copy action                        | reviewing, complete, interrupted, error; entry/result replace one stable item                                 |
| Safety review          | Exact reviewed action plus risk, authorization, and rationale                        | reviewing, approved, denied, timed out, aborted; stable replacement by review ID                              |
| Question               | All question types, options, free text, secrets and validation                       | unanswered, partially answered, submitted, expired                                                            |
| Service/error          | Quiet informational receipt or prominent actionable failure                          | transient/persisted distinction; retry guidance when available                                                |
| Artifact               | Typed preview with safe generic fallback                                             | creating, streaming, ready, versioned, error                                                                  |
| Sub-agent work         | Parent relationship and compact progress/report                                      | starting, running, waiting, complete, interrupted, error                                                      |
| Context/compaction     | Non-alarming first-class lifecycle receipt                                           | queued, running, complete, interrupted, error; token/context metadata only when provided                      |

Harness-injected envelopes that arrive wearing the user's role are not user
text. `<user_query>` wrappers unwrap to the typed prompt. Background-task
`<system-reminder>` completions become quiet service receipts. Other injected
preambles (`<user_info>`, skill catalogues, MCP connection notices, Claude
slash-command bookkeeping, FalconDeck skill file-reference wrappers) are
omitted or unwrapped to the typed prompt. Raw XML and skill path plumbing
never reach the bubble, export, or search index.

On native clients, selection means the rendered transcript text itself is
long-press selectable, including user and assistant Markdown, table cells,
footnotes, fenced code, and diff lines. Copy-whole-message and copy-code actions
remain available as faster complements; selectable behavior must not be applied
globally to buttons, labels, or lifecycle chrome.

Fenced code uses one 32px transition rhythm against adjacent Markdown blocks on
every client, including consecutive fences. A fence at the start or end of a
message does not add empty outer space beyond the message itself.

Image input is bounded consistently before it enters a provider stream: one
image may contain at most 10 MB of decoded data and one turn may contain at
most 15 MB across all images. Those are FalconDeck ingest caps: the local turn
body is 24 MiB and the relay encrypted frame is 40 MiB, which cover 15 MB
decoded plus base64 and AES-GCM expansion. Claude still embeds at most 7.5 MB
raw (10 MB encoded); client-side JPEG rewrite is what keeps typical screenshots
under that so the model actually sees them. They are not the provider vision
ceilings (ChatGPT/OpenAI accept 20 MB originals because that client compresses
before upload). Browser and desktop clients downscale pasted, dropped, and
picked files to a 2048px long edge and JPEG-encode anything over 1 MB (typical
macOS webpage screenshots) so several can share the 15 MB turn budget. HEIC/AVIF
becomes JPEG. Anything still over budget, or larger than 32 MB at the source, is
rejected. WKWebView encode uses `toDataURL` when `toBlob` returns nothing. Native
library and camera picks already request JPEG quality 0.8; mobile clipboard
pastes still enforce the decoded budget before relay encryption. The daemon
repeats the 10/15 MB check authoritatively before writing inline data to disk.
The error names an oversized image or explains the aggregate limit; attachments
already in the composer remain intact.

Browser image preparation is part of the conversation-scoped composer state.
Each selected or pasted file is announced as preparing, and every submit path
remains disabled until all overlapping preparation batches for that conversation
have settled. Navigation may continue during preparation: successful images return
only to the composer where selection began, failures leave its existing attachments
intact, and the aggregate byte budget is checked again against the latest attachment
set before an asynchronous batch is appended.

Image capability declarations are enforced before selection and again before
submission. Browser clients offer picker, clipboard paste, and drag-and-drop
through the same preparation path. The add menu explicitly advertises all three
paths. A mixed paste or drop attaches the supported images and names the skipped
non-image file instead of failing the whole batch or silently discarding it; the
message is attached to the composer and dismissible. Opening that menu with a
pointer must not paint a keyboard focus ring onto its first action, while a true
keyboard open retains normal focus-visible behavior. Native clients expose
clipboard paste, library, and camera actions only when the selected provider
advertises image support. Async native selection remains owned by the composer
where it began, even if the user navigates before preparation finishes. If a provider change
leaves images in the composer, the images remain visible and removable, sending
is blocked with an explicit explanation, and no client silently degrades them to
text references.

Option pickers remain direct menus while they contain fewer than eight choices.
At eight choices, they gain a search field at the top. Matching is
case-insensitive, requires every whitespace-separated query token, and searches
both the human label and useful identifiers such as model ids, project paths,
and branch names. Filtering never changes the selected value, empty results are
explicit, result counts are announced to assistive technology, and clearing or
closing a picker restores its complete option set. This contract covers desktop
and remote-web model/project/branch menus and every native option sheet, so new
long native pickers inherit search without bespoke wiring.

Provider-backed edit/resend is implemented for Codex on non-isolated, idle
threads. FalconDeck forks through the turn immediately before the selected user
message, opens the new provider-owned thread, and restores the selected text and
image attachments into that branch's composer without auto-sending. The first
message starts a fresh provider thread. Providers that do not advertise
`supports_forking`, old history without provider turn boundaries, active turns,
and isolated checkouts do not show a misleading action. The user message action
row instead offers a quiet, accessible explanation disclosure. Provider-level
copy names the active provider; temporary active-turn copy says when the action
returns; legacy history identifies the missing authoritative turn boundary.

Edit/resend and Try again expose stable busy state, then persistent inline
recovery copy beside the originating action if branching or submission fails.
The action is immediately available to retry; global transport banners and
toasts remain complementary rather than being the only place a failure appears.

## Interactive response contract

Approvals and structured questions share one ordered, pinned response queue on
every client. The oldest request is the only actionable card; a visible queue
position and pending count make later work discoverable without stacking every
blocking prompt into the composer rail. Snapshot and replay duplicates collapse
by request identity, queues order by provider creation time with a stable-id
tie-breaker, and the newest payload wins without duplicating its action surface.
An unresolved request never also appears as an actionable
transcript card, while its resolved receipt remains in history. Approvals retain
the exact command/path/context and support deny, allow, and provider-scoped
always-allow when the daemon advertises that response.

Resolved request items retain a typed, non-sensitive terminal outcome and
resolution timestamp so optimistic updates, the live transcript, reconnect and
relay replay agree on `allowed`, `always_allowed`, `denied`, `answered`,
`expired`, or `cancelled`. Question answer values are never copied into the
conversation receipt. Legacy boolean-only receipts render as neutral
"Resolved" history; clients must not infer approval from the request title.
If a turn reaches a terminal state before a still-pending request receives its
own resolution event, the daemon evicts that orphan from the response queue and
records it as cancelled so no client remains permanently blocked.

Question requests retain provider order and stable question IDs. Clients expose
one question at a time with progress, labelled single-choice options, a custom
answer path, secret-entry semantics, Back/Next/Submit controls, and validation
that prevents empty submission. Multi-question answers are sent atomically
through `interactive.respond`. A transport failure must leave every selected or
typed answer in place, show an inline retryable error, and also remain visible
through global connection status. A malformed request with no questions is an
explicit provider error, never an approval-shaped Allow/Deny prompt.
Native terminal notification feedback follows the authoritative response: a
tap may use ordinary press feedback, but success, denial, or error haptics fire
only after the relay acknowledges or rejects the response. A failed request
must never vibrate success first.

## Canonical fixtures

Automated renderer suites and manual QA should use the same scenario names and
semantics even where platform-specific fixture code is required:

- `mixed-complete`: every completed item kind in one realistically ordered turn;
- `mixed-streaming`: reasoning, text, tools and plan updates interleaved;
- `content-state-ladder`: assistant and reasoning pending, streaming, complete,
  interrupted, and error states, including terminal items with partial/no text;
- `tool-state-ladder`: every tool and approval state, including denial/error;
- `markdown-adversarial`: incomplete fences/emphasis/links/tables, long lines,
  nested lists, Unicode, RTL, unsafe URLs and very large code blocks;
- `media-matrix`: remote, local, data and unavailable image/file references;
- `interrupt-each-phase`: stop before output, during reasoning, text and tools;
- `reconnect-each-phase`: disconnect/replay during each streaming phase;
- `history-truncated`: relay truncation followed by authoritative snapshot/detail;
- `long-thread-1000`: heterogeneous items with a streaming tail and older-page load;
- `accessibility`: keyboard order, focus visibility, labels, reduced motion and
  lifecycle announcements with VoiceOver/TalkBack.

The desktop/web harness exposes the accessibility matrix at
`/conversation-qa.html?scenario=accessibility`; the native development client
uses `falcondeck:///conversation-qa?scenario=accessibility`. Both matrices keep
the same semantic coverage even where their platform fixture IDs differ.

Fixtures must use stable IDs, tied timestamps, out-of-order delivery and replayed
events so correctness does not accidentally depend on ideal provider timing.

Provider-owned structured values shown by generic tool, realtime, or unsupported
fallbacks are inspected through one shared bounded formatter. It caps depth,
collection entries, node count, individual strings, and final display size;
handles circular references, throwing getters, BigInt, and non-finite numbers;
and visibly labels a limited preview. Generic arguments, structured results,
resource metadata, and future content blocks use the shared preview/expand/copy
code surface, preserving the complete bounded inspection as the copy source.
Renderers must never run unrestricted
`JSON.stringify` over unknown provider data during conversation render.
Normalization also treats malformed primitives and malformed instances of a
known item kind as inspectable unsupported output with a deterministic ID and
the original kind/payload attached. One corrupt item must not fail an entire
thread-detail response or enter a specialized renderer with invalid fields.
The daemon applies the same rule before persistence: unknown provider-native
thread items become first-class `unsupported` receipts with stable identity,
content lifecycle, and a provider payload capped at 64 KiB. Live and hydrated
paths must produce the same receipt, and turn settlement must close any missing
terminal notification, so forward-compatible evidence survives reconnect and
never masquerades as generic tool activity.

Structured provider diagnostics use their human-readable message as the primary
service/error copy on every client. The exact provider payload remains available
behind a collapsed technical-detail disclosure; raw JSON must not become the
default conversation text merely because the diagnostic is not yet specially
classified. Expanded technical detail uses the bounded code surface so a large
diagnostic cannot inflate the transcript; its copy action still includes the
complete provider payload even when rendering is limited.

Failed, denied, and interrupted tools remain first-class transcript cards even
when read-only activity grouping is enabled. The auto-expand error preference
controls only initial disclosure; it never hides an abnormal terminal receipt.
A non-zero process exit is authoritative failure evidence even if legacy
provider display metadata says otherwise. Partial command output stays bounded
in the transcript, copyable in full, and one disclosure away on every client.
On native clients, expanded exact evidence is also long-press selectable:
command context, provider text and JSON, collaboration/sub-agent identity,
hook entries, and safety-review actions and rationale. Disclosure headers,
external links, and playback/export controls retain their own gestures.
The same boundary applies to other non-interactive provider evidence such as
plan explanations and steps, service diagnostics and exact technical detail,
file paths, web-search find patterns, and unsupported-output reasons. Compact
lifecycle labels and controls are presentation chrome, not selection targets.
Active approval and question prompts follow that contract too: provider-authored
titles, commands, paths, explanations, question headings, and question text are
selectable on native clients, while answer options, inputs, queue counters, and
response buttons retain their interaction semantics. Approval commands use the
bounded code surface: a compact preview, explicit expansion, and complete copy
even when rendering is performance-limited. Citation excerpts, memory
paths and notes, non-link source labels, and exact source locators are selectable;
external source links remain dedicated link targets.

Every native external-content target uses the same recoverable handoff contract,
whether it originates in assistant Markdown, a structured citation, web-search
activity, or an MCP resource link. Only allowlisted schemes reach the operating
system. If the platform rejects a safe URL, the target stays in place, exposes a
polite inline failure receipt, changes its accessibility hint to retry, and clears
the receipt after a successful retry. A rejected or unavailable browser must never
turn provider evidence into a silent no-op.

On macOS, the shell enforces that contract at the central anchor interceptor so
new structured output renderers inherit it automatically. The failure receipt is
linked to the original target with `aria-describedby`, preserves any existing
description/title, exposes retry progress, and ignores stale failure callbacks when
a newer open attempt has already succeeded. Unmounting the shell removes injected
receipts. iOS owns the equivalent state in its reusable external-URL action hook.
Native handoffs coalesce repeated taps for the same target, expose an accessible
busy state while the operating system owns the request, and ignore completion from
an older target or an unmounted row. A late failure must never replace the result of
a newer successful handoff.

Resolved approvals and questions remain quiet one-line receipts in history, but
the row expands to the complete normalized provider evidence on every client:
bounded/copyable commands, non-duplicated paths and human-facing detail, plus
question prompts and options. Valid provider transport JSON is reduced to useful
human copy instead of exposed raw. Question receipts never retain or render the
user's submitted answers, including secret values.

## Streaming transport contract

The first content fragment creates a complete `conversation-item-added` anchor.
Steady-state assistant and reasoning fragments use `text` events containing a
field target plus UTF-16 `start_offset` and `end_offset`. UTF-16 is deliberate:
the offsets match JavaScript and React Native string indexing, including emoji.

Clients apply a delta only when its start matches the current field length. An
already-present range is a replay no-op; a gap, malformed range, unknown item or
legacy unanchored delta is ignored until authoritative thread detail recovers it.
This makes relay replay and snapshot/event races idempotent while avoiding a
cumulative full-message payload for every token. Full item updates remain valid
for lifecycle transitions and non-append edits.

## Content lifecycle contract

Assistant messages and reasoning expose `pending`, `streaming`, `complete`,
`interrupted`, or `error`. History from an older daemon defaults to `complete`;
the first successful delta promotes its target item to `streaming`. When a turn
ends, the daemon settles only transient content (`pending` or `streaming`) to
the turn outcome, preserving earlier complete blocks in multi-part turns.

Pending content shows an honest receipt before the first fragment. Streaming
content is marked busy without announcing every token; native clients may use
one polite state announcement. Interrupted and failed content retain any
partial text and its copy action, with a visible icon and accessible terminal
label. Failures announce assertively and interruptions politely on DOM and
native clients. Reasoning uses the same terminal urgency without making its
streamed body a live region. Unsupported provider output scopes its live region
to the stable lifecycle header; an expanded raw payload remains silent while it
changes. Empty failed or interrupted turns receive one stable, empty assistant
receipt rather than disappearing. The receipt identity is derived from the
provider turn (or authoritative user item when a provider has no turn id), so
live settlement and later history hydration converge without duplication.
Failed assistant content also carries the provider-reported error when one is
available. Clients render that detail beneath the stable “Response failed”
label; older events without a detail keep the generic label.
Provider turn status restores the lifecycle of partial content during history
hydration; reconnect must never rewrite an interrupted or failed answer as
complete.

Settled reasoning may expose an optional authoritative `duration_ms`. A
provider-supplied duration wins; otherwise the daemon derives it from the
reasoning start and completion or turn-settlement timestamps. Clients show the
duration only after reasoning settles and never run a wall clock or rerender on
timer ticks while reasoning streams. Legacy history and events without reliable
timing omit the value rather than inventing one.

## Response action and regeneration contract

Completed, interrupted, and failed terminal answers expose “Try again” only
when the active provider can branch history at an authoritative turn boundary.
The action creates a provider-owned branch immediately before the originating
user turn and resends that exact text and image input with the source thread's
model, reasoning, approval, service-tier, permission, and sandbox settings.
The original thread is never rolled back or mutated.

The originating user item, rather than visual adjacency alone, is the retry
source. Interim commentary has no retry action. A steering user message without
its own provider turn boundary clears the retry candidate so a later response
can never accidentally resend an older prompt. If branching succeeds but the
new turn fails to start, clients retain the new branch and restore the exact
input to its composer for a manual retry. Unsupported providers and running or
input-blocked threads show no misleading action.

Branch-backed response actions become busy and disabled before their first
asynchronous handoff. Their accessible name communicates branch creation or
retry progress until the complete branch/turn operation settles. Repeated taps
during that interval are no-ops, so latency can never create duplicate branches
or duplicate regenerated turns. The host remains responsible for presenting a
failed branch or retry through its durable error surface.

## Assistant phase and evidence contract

Assistant messages preserve the provider's optional phase instead of treating
all text as one visual level. `commentary` is interim progress narration and
renders with a restrained “Progress update” treatment; `final_answer` is the
terminal answer. Missing phase remains visually compatible with legacy
providers and must not be guessed from message position.

Codex `memoryCitation` data is retained as structured file evidence on the
assistant message: path, inclusive line range, provider note, and originating
thread IDs. Evidence is collapsed by default, keyboard/VoiceOver expandable,
and remains attached through streaming completion, interruption, history
hydration, and replay. These local memory citations are distinct from web
sources and Markdown links; clients must not rewrite one kind into another.

## Image output contract

Agent-produced images are structured `image` conversation items rather than
tool-output strings. The item carries a stable asset id, display title, MIME
type, renderable URL, optional daemon-local path, accessible description, and
the shared content lifecycle. Codex `imageGeneration` and `imageView` history
and notifications map to this item directly.

Daemon history keeps local paths compact. At the client transport boundary,
readable local images are cloned to data URLs so remote web and iOS never need
daemon filesystem access. Remote/data URLs pass through unchanged. Renderers
validate every reference before it reaches a browser or native decoder, show a
dimensionally stable generating receipt, preserve interrupted output, expose
image-load failure explicitly, and use provider descriptions as alt text. Every
usable result opens a labelled, keyboard/VoiceOver-dismissible full-size preview
inside FalconDeck, including safe inline/data assets. Opening the original outside
FalconDeck remains a separate explicit action offered only for HTTP(S) assets;
native handoff failures stay visible and retryable.

The reserved image canvas exists only while an asset is generating or remains
renderable. A terminal item with no usable asset collapses to a compact explicit
unavailable receipt, retaining its caption and lifecycle without forcing the
reader past an empty image-sized panel. Provider image failures announce
assertively; later decoder failures remain polite because they can occur while
reviewing settled history.

Safe images embedded in MCP and dynamic-tool output follow the same in-FalconDeck
preview contract. They remain in provider order inside the tool evidence, never
decode unsafe references, return focus to the thumbnail on DOM dismissal, and
surface thumbnail or full-preview decode failure without hiding the surrounding
tool result.

## User attachment contract

User image attachments retain stable identity, filename, MIME type, renderable
URL, and daemon-local path metadata across optimistic send, history hydration,
queueing, reconnect, and replay. Browser clients render only HTTP(S), blob, or
base64 `data:image/*` URLs; native clients additionally accept the image-picker
`file`, `content`, `ph`, and `assets-library` schemes. Executable and mismatched
media schemes never reach an image decoder.

Every usable thumbnail has a labelled full-size preview action. The preview is
keyboard/VoiceOver dismissible, preserves contain sizing, and does not require
an external browser. Thumbnail and full-size decode failures, plus expired or
unsafe references, become an explicit “image unavailable” receipt that retains
the filename; they never leave a blank or broken image. Unnamed references use
one compact derived filename on every client and never expose a data URL or
signed query string as their label. Removal remains independently operable in
the composer, user-authored text has the same accessible copy action on all
clients, and provider-backed edit/resend remains available for image-only
turns. FalconDeck currently sends image inputs only, so non-image file picks
must be rejected with an explicit explanation rather than silently discarded.
The current Codex app-server input union has text, image/local-image, skill, and
mention variants but no generic file input; Claude's CLI similarly exposes
filesystem access rather than a streamed file-attachment variant. Generic file
support therefore needs an explicit bounded text/document translation or a new
provider capability contract. Do not fake it by sending an inaccessible client
path or by adding a FalconDeck conversation database.

## Web research and citation contract

Provider-native web research is a structured `web_search` conversation item,
not a generic tool title. It preserves the top-level query, batched queries,
typed action (`search`, `open_page`, `find_in_page`, or `other`), page URL,
find pattern, stable identity, and shared content lifecycle. The action field
is open-ended on the wire: known camel-case aliases normalize to the shared
values, while future provider actions remain intact and human-readable. Codex history and
live `item/started` / `item/completed` notifications map to the same shape.

Clients show an honest busy receipt while research is active, distinguish
searching from opening or searching within a page, retain action context after
failure or interruption, and expose only trimmed, credential-free HTTP(S) page
URLs without control characters as links. Search actions and citations share
this single URL policy, so a provider URL cannot be actionable on one client or
surface while inert on another. Terminal failure is announced as an alert and
interruption as a polite partial-result status without discarding the query,
action, or already-safe page link. A search
action is not itself a citation and clients must never invent a source result
the provider did not emit. Inline citations in assistant Markdown and future
provider-emitted source lists remain distinct presentation layers that can
reference the same canonical URL.

Assistant messages also accept an optional open-ended `citations` list for
evidence the provider explicitly attaches to its text. Each entry preserves the
provider citation kind, safe web URL or stable non-web source id, title, and
supporting excerpt. A search-result `source` may itself be an HTTP(S) URL and
receives the same safe-link treatment as the explicit `url` field. Optional
provider locators preserve stable streamed identity plus exact web-search,
search-result block, document block, page, or character ranges; malformed
ranges degrade to ordinary readable source metadata rather than invalid UI.
Clients collapse this evidence by default, expose a
keyboard/VoiceOver disclosure, open only HTTP(S) links, and leave non-web ids
readable without treating them as links. Source rows are numbered consistently
and expose human-readable location context without displaying opaque provider
tokens. Expanded source lists render progressively in twenty-item pages so a
large provider result cannot block scrolling. Labels, supporting excerpts,
memory paths, and notes have bounded display previews with an explicit limit
receipt; the normalized provider evidence remains intact. Native link failures
remain visible and retryable instead of disappearing after a failed OS handoff.
The same citation may arrive in a
complete assistant content block or as a streamed citation delta; replay and
hydration deduplicate it without changing the response text. The daemon assigns
each first-seen citation a stable source-part id. Later title, excerpt, URL, or
locator enrichment updates that ordered part in place instead of appending a
second source or remounting its disclosure/link state. Older history without
ids falls back to provider locator, URL/source reference, and finally readable
metadata identity.

This field is deliberately dormant when no provider metadata exists. Codex
app-server currently documents `agentMessage` as text/phase and `webSearch` as
query/action only, so Codex search activity never populates `citations`.
Claude's API defines `web_search_result_location` and
`search_result_location` evidence on assistant text, but Claude Code 2.1.224
currently emits a WebSearch answer's sources as ordinary Markdown links. Those
links remain ordinary Markdown unless a future CLI stream preserves the
structured citation objects. See the official [Codex app-server item
contract](https://learn.chatgpt.com/docs/app-server#items), [Claude web-search
contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool),
and [Claude search-result citation
contract](https://platform.claude.com/docs/en/build-with-claude/search-results).

## Provider artifact contract

Provider-native artifact previews are structured `artifact` conversation items,
not generic unsupported warnings. Each item preserves stable provider identity,
an open-ended artifact kind, human title, optional MIME type and version, a
provider reference or safe external URL, bounded inline text content, the exact
size-bounded artifact payload, and the shared content lifecycle.

Creating and streaming artifacts show an honest busy receipt before preview
content exists. Ready artifacts render JSON, Markdown, or code through the same
bounded transcript surfaces used by provider tool artifacts. Failed and
interrupted artifacts retain their partial preview, reference, and technical
evidence. HTTP(S) URLs use the shared recoverable external-handoff contract;
provider-local schemes such as `asset:` remain selectable reference text and
never reach a browser or operating-system URL handler. Technical payloads are
collapsed by default, formatted through the bounded inspectable-value path, and
shown through the same preview/expand/copy code surface on every client.
Terminal artifacts with inline content also expose a first-class export action:
Download on desktop and remote web, and the native Share sheet on iOS. Export is
suppressed while an artifact is pending or streaming so a user cannot save a
half-written provider result. The transcript keeps the provider's readable
title and MIME metadata, while the file handoff uses a shared portable leaf
filename and accepts only a bare validated media type. Invalid media metadata
falls back to `text/plain` for browser text downloads and is omitted from the
native share-sheet hint. A safe remote Open action remains separate from the
inline-content export.
Malformed artifact shapes continue through the generic unsupported receipt so a
new provider version cannot break thread hydration or the transcript renderer.

## File-change contract

Provider patch operations are structured `file_change` conversation items,
not empty generic tool rows and not inferred from the turn-level aggregate
diff. Each item preserves its stable provider id, raw and normalized lifecycle,
ordered paths, open-ended change kind, per-file unified diff, optional rename
destination, start time, and terminal time.

Codex `fileChange` thread history, `item/started`,
`item/fileChange/patchUpdated`, and `item/completed` all update the same item
identity. Patch updates are authoritative replacements rather than appended
text deltas, and retain the original start timestamp. Clients show a compact
busy receipt before the first patch arrives, then an accessible file-count or
single-file summary with expandable paths and rendered diffs. Renames stay
explicit, failures and declines retain their file evidence, and desktop file
paths continue to open the native changes panel when the host supports it.

## Command-execution contract

Provider command executions remain tool calls so read-only activity grouping,
approval behavior, and generic fallback keep working, but carry structured
`command_execution` detail. That detail preserves the exact command, working
directory, provider-parsed semantic actions, process id, duration, and source.
History restores terminal output from Codex `aggregatedOutput`; live
`item/commandExecution/outputDelta` notifications append to the same stable
item using UTF-16 offsets and replay rules from the streaming contract.

Clients show lifecycle and command identity in the compact row, with an
accessible disclosure for working directory, duration, semantic action context,
and terminal output. Evidence remains available for failures and interruptions.
Read-only detail suppression remains a user preference, and older tool calls
without structured detail continue to render through the generic path.

## Test-run contract

Providers currently expose test runs through command execution rather than a
portable structured result event. The raw terminal output therefore remains
authoritative and is always retained. For calls classified as tests, the daemon
may attach an optional `test_summary` to display metadata with runner identity,
test and suite pass/fail/skip counts, and normalized wall duration.

Summary parsing is deliberately conservative and ANSI-tolerant. FalconDeck
recognizes stable summary lines from Vitest/Jest, Cargo and nextest, pytest,
Node TAP, Go, and XCTest-style output; an unknown or partial format simply keeps
the existing lifecycle row and raw output. Clients never infer a passing result
from process success alone, and a parsed summary never replaces failure names,
assertions, stack traces, or other provider evidence.

Completed results show one compact, accessible pass/fail badge in the tool
header and an expanded semantic summary before the terminal output. Failed runs
use the error treatment and remain open according to the failed-test preference.
Running and interrupted test calls retain their live or partial output even
before a terminal summary becomes available. Older daemons omit the field and
continue through the generic command renderer without a compatibility break.

## Provider-native tool result contract

Codex `mcpToolCall` and `dynamicToolCall` items retain their provider-native
identity instead of collapsing into generic tool text. MCP detail preserves the
server, tool, arguments, app/connector context, duration, error, and the complete
open-ended `CallToolResult`. Dynamic detail preserves namespace, tool, arguments,
success, duration, and the ordered text/image content list.

Known MCP content blocks render semantically and in provider order: text, images,
audio, resource links, and embedded resources. `structuredContent`, `_meta`,
supplemental result fields, and unknown future content blocks remain inspectable;
an unrecognized provider addition must never silently disappear. Executable URL
schemes are rejected and media data URLs must match the media type. Live
`item/mcpToolCall/progress` messages append to the stable tool id using the same
UTF-16, replay-safe output delta path as command execution.

Current daemons also derive an optional `provider_output_summary` on the tool's
display metadata. It contains text-block and per-artifact counts computed without
decoding or copying inline provider payloads. Clients use that summary for
collapsed badges, history grouping, and duplicate-text suppression, then parse
the authoritative result only when its detail is opened. History from older
daemons omits the field and falls back to the same conservative raw-result scan;
the summary never replaces, reorders, or truncates the provider result.

Opening a provider call prioritizes its error, ordered result content, and
artifacts before technical invocation arguments. Arguments remain lossless and
copyable behind a nested accessible disclosure whose closed label reports a
bounded shape such as `11 fields`; calculating that shape does not read provider
property values, and full safe formatting is deferred until the disclosure is
opened. This prevents a large input object from pushing the answer below the
fold on a phone while keeping complete evidence one action away.

The same media safety rule applies to provider-defined dynamic tool images.
Unsafe or mismatched URLs remain inspectable as structured data and never reach
an image decoder. A safe URL that later fails to decode is replaced by an
explicit accessible “image unavailable” receipt on every client rather than a
broken or blank frame.

Resource links and embedded resources are provider artifacts attached to their
authoritative MCP call; clients must not duplicate them into synthetic transcript
items. Artifact-bearing calls are high-signal evidence: they remain standalone,
open by default, and visible even when read-only details are grouped or hidden.
Resource links are labelled as references, not citations, because the provider
has not necessarily asserted that the assistant answer cites them. Preserve the
provider name, description, MIME type, size, icons, annotations, metadata, URI,
embedded text or bytes, and result order. Third-party icon URLs are metadata only
and are not fetched automatically, avoiding an implicit tracking request.

HTTP(S) references open through the clients' safe external-link path. A native
handoff failure remains attached to the exact reference and can be retried without
collapsing the MCP evidence. Browser
clients offer a filename-bearing download for embedded binary and text data.
Native clients materialize provider-supplied text or strict base64 data URLs to
a shared sanitized provider filename inside a unique short-lived cache
directory only
after the user presses Share, invoke the platform share sheet, and remove the
temporary directory after the sheet closes. This keeps the share-sheet title
clean without risking cache collisions. Browser download hints and native file
handoffs use the same portable filename and bare-MIME validation contract.
Native preparation is capped at 50 MB
to avoid multiplying a very large inline payload in memory. The client derives
UTF-8 or decoded-base64 size when provider metadata is missing or understated,
without allocating a second full payload. Unsafe/missing content and an
unavailable platform sharing surface an inline error without losing the
artifact receipt. This
follows Expo SDK 54's [FileSystem](https://docs.expo.dev/versions/v54.0.0/sdk/filesystem/)
and [Sharing](https://docs.expo.dev/versions/v54.0.0/sdk/sharing/) contracts.

Text artifacts use their MIME type and filename for preview: Markdown renders
as safe rich content, JSON as structured data, common source formats as
highlighted code, and long native plain-text previews are capped at 40 lines
with the full artifact still available through Share. Missing readable content
is shown as such rather than as an empty card. Structured results remain visible
alongside resources and count as provider artifacts without being presented as
downloadable files.

Desktop/web use native audio controls and safe external resource links. iOS
decodes safe remote or inline audio through the native audio graph and exposes
an accessible play/stop/retry control. Only one finite tool output plays at a
time, collapsing its card stops playback, decode work is cancellable, and a
small bounded cache prevents long histories of inline media from growing memory
without limit. Native clients retain an explicit typed fallback for media or
schemes they cannot safely open. Generic output is suppressed only when the
corresponding structured text is already visible, preventing duplicate results
without dropping fallback evidence.

Provider text results from MCP and dynamic tools use the same bounded code
surface on every client. Previews show twelve lines before explicit
expansion, remain long-press selectable, and copy the complete provider string;
a large connector result must never become an unlimited raw text node inside a
virtualized transcript row.

## Collaboration and sub-agent contract

Codex `collabAgentToolCall` is structured conversation evidence, not a generic
“Tool” receipt. The detail retains the operation (`spawnAgent`, `sendInput`,
`resumeAgent`, `wait`, or `closeAgent`), sender thread, ordered receiver threads,
delegated prompt, requested model/effort, and the last known state and message
for every target agent. `subAgentActivity` likewise retains its lifecycle kind,
agent thread id, and agent path.

Clients use operation-specific labels, preserve stable thread identity, expose
the delegated prompt, and show mixed per-agent states independently—a completed
agent must not make a still-running sibling look finished. Running waits retain
the normal busy lifecycle; errored and interrupted agents use explicit wording
and icons. Completed collaboration runs fold into the same ordered work-session
model as other tool activity, while their full evidence remains accessible.

## Operational output contract

Errors are routed by semantic ownership, not by provider log severity. A tool
failure updates that tool's transcript receipt; a turn failure settles the
assistant receipt with its provider explanation; an approval, form, or other
control failure stays beside that control. Short-lived failures caused by a
user action may additionally use a toast. Raw provider stdout/stderr is daemon
diagnostic logging and never becomes user-facing content by itself.

Workspace degradation uses keyed active operational conditions. Re-emitting the
same `(workspace, key)` replaces its severity and message while preserving its
identity and first-seen time; successful recovery explicitly clears it. Clients
show the highest-severity active condition in the top banner and expose all
remaining conditions through a compact issue center. Dismissal applies to one
condition version, so a materially updated condition becomes visible again.
This zone is reserved for current provider availability, authentication,
configuration, connection, and capability problems—not historical turn or tool
failures. Fatal application startup failures remain a separate blocking screen.

Operational provider output is part of the transcript when it affects the
user's understanding of a turn. Restored and live Codex plans preserve their
free-form text, with replay-safe UTF-16 `item/plan/delta` updates until an
authoritative structured plan replaces them. Structured plan steps retain an
optional provider ID across text, status, and order changes. Older history falls
back to deterministic text-and-occurrence identity. Each provider turn owns a
separate plan item; repeated updates within that turn replace it rather than
duplicating rows or overwriting a previous turn's plan. Clients normalize common
provider aliases into pending, in progress, completed, blocked, or failed while
retaining an intelligible visible label for future states. DOM and native rows
expose the same step-and-status accessibility label. Multi-part reasoning summaries
retain explicit part boundaries. `hookPrompt` fragments are retained as service
evidence; hook runs preserve lifecycle, event/handler/mode/scope, source path,
duration, status detail, and typed warning/error/feedback/context entries.
Approval auto-reviews are stable structured tool receipts keyed by provider
review ID. They retain the exact action target, working directory, target item,
review state, risk and authorization levels, rationale, decision source, and
duration. Denials and critical-risk reviews use urgent visual and accessibility
semantics; an in-progress review remains visibly active until its terminal
notification replaces the same item. Every client exposes the action category,
exact target item, and decision source rather than silently retaining those
fields only in protocol storage. Active reviews never invent a decision source;
approved, denied, timed-out, aborted, and future provider states remain
distinct and human-readable.

`sleep` items use duration-specific labels instead of “Tool”. Codex
`contextCompaction` items remain first-class ordered receipts instead of being
flattened into generic tools or buried inside a work-session fold. The same
stable item ID moves from running to complete, while turn settlement closes a
missing terminal notification as succeeded, interrupted, or failed. Current
app-server items carry no compaction summary or token metadata, so clients do
not invent either; they show calm provider-independent lifecycle copy.
Review-mode entry and result notifications replace one first-class code-review
item keyed by the provider ID. The entry retains the requested scope and shows
calm active progress; the result preserves that scope while rendering the full
provider-authored findings as streaming-safe Markdown with copy, interrupted,
and error states. A review item counts as the turn's terminal output, so a
failed or interrupted review never gains a duplicate empty assistant receipt.
Thread-targeted provider,
guardian, model-verification, model-reroute, and safety-buffering notifications
become retained service items; warnings and errors use alert semantics and
cannot look like quiet informational text. Global deprecation/configuration
warnings become active workspace conditions when no thread target exists. They
survive reconnect snapshots, remain outside conversation history, and can be
dismissed locally.
Structured diagnostic detail is collapsed by default and uses the same bounded,
copyable technical-detail surface as an in-transcript service receipt.

`thread/tokenUsage/updated` is retained separately from thread summaries and
transcripts so high-frequency usage updates do not reorder or rerender sidebar
rows. Every client shows the same compact accessible meter when the provider
reports a model context window, warning at 70% and becoming urgent at 90%.

Realtime voice transcript deltas use one stable assistant-message identity and
the same UTF-16 replay-safe text event contract as typed responses. The final
assistant transcript is authoritative; user speech is committed only from the
provider's final transcript so partial recognition does not create misleading
user messages. Realtime errors and early closes settle partial assistant text
honestly. Realtime PCM audio plays through ordered low-latency queues on
web/macOS and iOS, and interruption discards stale queued speech. Audio and
unstable raw realtime items are end-to-end encrypted but live-only across the
relay: they must never inflate retained replay or daemon snapshots. Non-audio
items such as handoff requests remain visible and inspectable through a
size-bounded generic card rather than being silently discarded. Realtime,
unsupported, and artifact technical payloads share the bounded code surface on
every client so expanded evidence cannot inflate a transcript and its complete
formatted inspection remains copyable.

`terminalInteraction.stdin` is intentionally never echoed into the transcript:
it is user/process input and may contain secrets. Command output remains the
auditable result through the normal command delta path.

## Tool lifecycle contract

The daemon projects provider-specific tool status strings into
`ToolCallDisplay.lifecycle`: `unknown`, `queued`, `awaiting_approval`, `running`,
`succeeded`, `failed`, `denied`, or `interrupted`. A non-zero exit code is
authoritative and always produces `failed`. Clients retain the raw provider
status for inspection and derive the same lifecycle locally when reading
history from an older daemon. If an individual terminal tool event is lost,
the enclosing turn settles transient calls to the same outcome: completed,
failed, or interrupted. A failed turn can never silently turn its active tools
green.

Each lifecycle has distinct accessible wording and iconography; error and
denial cannot be communicated by color alone. Calls without detail are static
status rows rather than dead disclosure controls. Approval-waiting detail stays
expanded and non-collapsible until the authoritative request resolves.

## Performance and correctness gates

- Syntax highlighting stays off the startup path and only the finite grammar
  set exposed by FalconDeck is emitted. Importing Shiki's full bundled registry
  is prohibited: it makes every grammar/theme part of desktop and remote build
  output even when none is fetched initially. Unsupported fences render as
  readable plain text, and a failed engine/grammar fetch remains retryable.
  DOM clients use Shiki's browser-oriented JavaScript RegExp engine; shipping
  or loading the Oniguruma WASM payload is prohibited. Fenced code in a
  streaming assistant message or thought also remains plain until that item
  settles, and the previous language/theme tokens must be cleared before a new
  tokenization request so stale code is never painted. Retokenizing the growing
  block on every delta is prohibited. Remote-only preference UI is a
  user-triggered chunk and may be prefetched on pointer or keyboard intent. The
  shared command palette is also an explicit lazy subpath: desktop and remote
  web load it on the first command/search shortcut, preserve that initiating
  request while the chunk resolves, and keep it mounted for instant subsequent
  toggles.
- At most one React state commit per display frame for a burst of stream events.
  Remote web and native capture the pending relay queue once at the start of a
  scheduled frame; updates arriving while asynchronous decryption is underway
  remain queued for a later frame. A truncation cursor is not adopted until all
  captured frame batches and parked encrypted updates have drained. When a
  snapshot response races that async decrypt and must be replaced, its held
  replay high-water mark survives into the replacement request; only the
  authoritative replacement may checkpoint it. Snapshot retry setup must not
  reset a cursor for an already-consumed update from the same relay session.
- No cumulative full-message payload per token on the steady-state delta path.
- Composer input remains responsive while Markdown, diffs and tools stream.
- A streamed fenced-code language header with no body yet renders as an empty
  code surface; provider-visible placeholders such as `undefined` must never be
  synthesized while waiting for the first code token.
- Clearing a submitted composer is optimistic, not destructive. If transport
  submission fails, the exact text and attachments return to that
  conversation without overwriting anything authored or picked while the
  request was pending. Failed content remains first, newer text follows after
  a blank line, and attachments retain chronological order with stable-id
  deduplication.
- Losing transport connectivity gates Send/Stop but does not lock drafting,
  attachment picking, or per-conversation draft persistence. The unavailable
  action exposes a screen-reader reason and becomes actionable again after
  reconnect without discarding input.
- Scrolling up disables bottom-follow; returning to the tail restores it.
- Prepending history and expanding content preserve the visible anchor.
- Every client opens a bounded authoritative tail and exposes earlier history
  while `has_older` is true. Older pages prepend by stable `(kind, id)` identity;
  the first page clears the partial-history state without discarding the live
  tail. Desktop, remote web, and iOS use the same merge contract.
- A tail refresh replaces stale items inside its first stable overlap while
  preserving only the continuous older prefix. With no overlap, the fresh tail
  wins rather than joining unrelated provider histories. An in-flight older
  page is discarded if refresh, reconnect, or another page changes the oldest
  boundary it requested.
- Only changed blocks render; completed siblings retain referential identity.
  The DOM transcript places each structurally shared history block behind its
  own memo boundary, so a 1,000-message tail delta reconciles exactly the
  changed row rather than rebuilding every wrapper and action subtree.
- Replayed events are idempotent and stale snapshots cannot roll state back.
- An offset-valid delta that arrives after a terminal full-item update may add
  missing provider evidence, but it must preserve `complete`, `interrupted`, or
  `error` content lifecycle and terminal tool state. Late replay must never
  reopen a settled row as streaming or running.
- Browser and mobile snapshot requests buffer and deduplicate daemon events
  that finish flushing while the RPC is in flight, then replay them after the
  snapshot (in one store transaction on mobile). An active decrypt/flush or
  bounded-buffer overflow invalidates the response and triggers a fresh
  request. Browser effects cancel on session identity changes, and mobile
  disconnect invalidates the request generation, so an old promise cannot
  overwrite a newly paired session.
- The local macOS event socket subscribes before creating its initial snapshot
  and reseeds with a snapshot after receiver lag. Reconnect discards any
  frame-batched events from the dead socket before adopting the new HTTP
  bootstrap, preventing a stale frame from briefly rolling fresh state back.
- Background clients drain bounded queues and recover explicitly after eviction.
- Remote-web durable action polling is scoped to one authenticated session
  generation. Rotation aborts only the old controllers without deleting action
  ids; the next session resumes them with its own token. Completion and terminal
  authentication/not-found failures clear the id, while aborts, timeouts and
  transient relay failures retain it. `remoteAppUtils.test.ts` exercises this
  lifecycle without a live relay.
- The iOS connection effect owns the WebSocket-ticket request it starts. Session
  rotation closes the captured socket, fails that generation's pending RPCs and
  ignores any old ticket that resolves after the new session connects. It also
  cancels and empties a queued display frame, so even a host that dispatches the
  cancelled callback cannot apply the old session's encrypted delta. Updates
  injected while a frame is awaiting decryption remain queued until the next
  frame callback instead of causing a second commit in the same paint. The
  two-pairing integration harness in `useRelayConnection.integration.test.tsx`
  verifies the credential handoff, late-response race, stale-frame dispatch and
  mid-decryption arrival boundary.
- No transcript action depends only on hover, color, or an unlabeled icon.
- The shared DOM composer has a stable “Message composer” accessible name,
  and disabled state is applied to the textarea itself rather than only its
  surrounding mode controls.
- Tool lifecycle labels are polite live regions on DOM and native clients, so
  queued/running/completed/failed/denied/interrupted transitions are announced
  without exposing spinner icons to accessibility APIs.
- Assistant response completion uses one shared identity tracker on DOM and
  native clients. It waits for both the exact non-commentary assistant item and
  the enclosing turn to settle, even when those updates land in separate store
  commits. Loaded history, thread switches, failed sends, interrupted/error
  content, and backgrounded native turns never announce an older response as
  complete. The transcript itself remains non-live so token deltas are silent.
- DOM clients suppress animation, transitions, and smooth scrolling under
  `prefers-reduced-motion`. Native transcript collapsibles, progress spinners,
  pulsing status dots, skeletons, and press feedback use the OS reduced-motion
  preference and settle immediately to a static state.
- Native text inputs and labelled buttons use minimum heights rather than fixed
  heights so Dynamic Type can grow without clipping. Full-screen setup and
  recovery flows must remain vertically scrollable at the largest accessibility
  content size; their fields and disclosures retain explicit VoiceOver labels,
  hints, roles, and state.
- Remote setup and fatal-recovery shells add their visual gutter to hardware
  safe-area insets. At a 320 px viewport, fields retain a 24 px side gutter and
  the document must not gain horizontal overflow.

Measure time to submitted feedback, first visible agent activity, first visible
text, stream commit duration, dropped frames, reconnect recovery time and memory
for `long-thread-1000` in release builds.

The shared presentation layer structurally reuses unchanged history and live
activity blocks by stable id plus authoritative item reference. A tail delta in
a 1,000-item thread must retain the other 999 block identities, including the
retry-source lookup used by native list callbacks. Prepending older history must
reuse the shifted blocks by id. The reproducible microbenchmark lives in
`packages/client-core/src/conversation-performance.bench.ts`; run it with
`npx vitest bench packages/client-core/src/conversation-performance.bench.ts --run`.
It measures both presentation reuse and a 100-delta display-frame burst against
the legacy event-at-a-time applicator. The batched case must remain faster while
retaining replay, gap, ordering and untouched-item identity tests in
`conversation-performance.test.ts`.
The shared Rust `ConversationItem` also stays at or below 256 bytes so a long
thread does not pay inline storage for rare, metadata-heavy tool displays or
interactive prompts. Those fields are boxed without changing their JSON wire
shape; `conversation_item_size.rs` guards the layout.
Native transcripts virtualize heterogeneous rows with FlashList. DOM transcripts
keep the newest forty blocks eagerly laid out for streaming and bottom anchoring,
then apply `content-visibility: auto` plus a cached intrinsic-size estimate to
older blocks. This defers offscreen layout and paint without removing history
from find-in-page, keyboard navigation, selection, or the accessibility tree.
`ConversationPerformance.test.tsx` replaces the row contents with a render
probe and requires a 1,000-message streamed tail update to render only the tail.
Desktop and native `long-thread-1000` fixtures stream the final block while the
reader is both pinned to the tail and scrolled into older history.
Every native renderer is keyed at the shared message-routing boundary by stable
render-block identity. FlashList may reuse its outer cell, but disclosure, preview,
retry-error, paging, and export state must remount for a different block while
remaining intact across deltas and lifecycle updates to the same block.

Attachment previews are owned by stable attachment identity but always derive
their URL, label, and availability from the current authoritative message or
composer list. Replacing an attachment updates an open preview; removing it closes
the preview, and a later attachment must never resurrect stale media from a recycled
row or a cleared composer.

The packaged macOS process explicitly installs the AWS-LC rustls provider before
starting Tauri. The updater also compiles Ring while daemon networking compiles
AWS-LC; leaving selection implicit causes rustls to panic on the first TLS
connection. Native QA must confirm both the `tauri://localhost` page-finished
event and an absence of content-process termination/provider panics.

## QA closeout

A conversation change is not complete until its affected rows above have:

- shared normalization/presentation tests;
- desktop and remote-web renderer tests where the shared DOM is involved;
- iOS renderer/store tests where native behavior differs;
- a live provider smoke test for both Codex and Claude when provider parsing changed;
- macOS, browser and iOS Simulator visual/interaction verification; and
- reconnect, interruption and error verification when lifecycle code changed.

Record deliberate parity exceptions in this file with the provider/platform
capability that requires them. A missing implementation is not a parity exception.
