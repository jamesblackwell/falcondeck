# Conversation loading and sidebar QA — 17 October 2026

This pass addresses the blank conversation pane, unloaded Chats, and unstable
folder expansion reported from the development iPhone app.

## Fixed

- Casual workspaces were never requesting their first task page. Load one page
  per visible scope, serially, and restart when the connection or compact index
  changes. Chats is one sorted section with one Show more control.
- Replacing the sidebar's lazy stack with a plain native List removes estimated
  row-height gaps after collapsing projects while pages arrive. Rows retain their
  44-point targets, compact pins, project/folder hierarchy and context menus.
- Folder chevrons rotate in place. Disclosure changes animate immediately and
  remain interactive while preferences save. Rapid taps serialize and coalesce
  to the latest intent; a failed save restores the synced state with an error.
- Conversation loading, errors with retry, and empty states sit over the pane,
  outside its bottom-anchored transcript list. They stay visible above the
  composer. An initial failure cannot masquerade as an empty conversation.
- Initial history uses the same 20-item tail as Expo; older pages still fetch 50
  items. Images and large tool outputs remain separately loaded.
- Leaving a view no longer discards an otherwise valid in-flight read. Responses
  still require the current connection and index/load identity. Reopening shares
  the load; a retry or shared completion acknowledges the visible conversation
  after history is ready.
- Task pages and metadata bursts publish one batch, rebuilding sidebar grouping
  once per batch rather than for each task.

## Verification

The baseline phone UI run failed for unloaded Chats and missing pane loading
state. Focused regressions cover twelve initially unloaded casual workspaces,
five-second history requests, failed first reads and retry, reopening during a
request, unread acknowledgement, compact row spacing, and repeated folder taps.

130 unit tests pass. New unit regressions cover cancelled read retention, fresh
index paging, folder save ordering/failure/connection changes, history
projection, archive during history loading, and older-page failure isolation.
Phone and iPad UI checks also cover sidebar hierarchy, search into
collapsed sections, reselecting destinations, composer bounds and sheet handoffs.

Local screenshots are in the ignored
[QA gallery](artifacts/loading-2026-10-17/index.html). They include dark iPhone
and light iPad loading, retry, loaded chat, folder and navigation states.

The repository-required review used
`.agents/skills/autoreview/scripts/autoreview --mode local --max-priority P2`
with the native model, event, paging, session and view files as context, in an
isolated copy of this patch. Its first pass found the unread acknowledgement
race after a retry/shared load. Follow-up review also checked archive/session
ownership and older-page errors. Verified findings were fixed and covered with
regressions. The final rerun reported **no actionable P0–P2 findings**.

The signed development build was installed over Wi-Fi on the paired iPhone and
launched successfully. The app and its speech extension were observed running.

A separate, local-only UI smoke check used the simulator's existing real-relay
pairing. It opened a project conversation, verified populated history, opened
the flat Chats section, and loaded a casual conversation successfully. Those
captures stay in the ignored gallery directory. One cold casual history RPC
took approximately 12 seconds before its response arrived; the native loading
state stays visible throughout. The smaller first page reduces transfer and
rendering work, but does not eliminate cold history work on the paired computer.

All changes are confined to this standalone native client. No Expo build, OTA,
TestFlight upload, relay deployment or production build is involved. Slow-link
and failure checks use deterministic local fixtures; their five-second delay
is a test condition, not a measurement of the real relay.

## Physical-device scrolling follow-up

The post-install process check caught two iPhone crashes in
`UICollectionView._validateScrollingTargetIndexPath` during SwiftUI's deferred
list updates. The transcript scheduled unstructured ScrollViewProxy requests
for changing item indices; these also survived leaving a conversation.

Transcript scrolling now has one view-scoped owner. It coalesces requests,
cancels when the view disappears or the user starts reading, and uses the
current native scroll view's laid-out content bounds instead of a deferred
collection item index. Initial positioning and older-page preservation use
that owner too. Row background probes bind to their own live collection view;
an older-page anchor cannot move a replacement conversation.

New regressions cover row replacement before scrolling, cancellation on view
departure or row interaction, and prepend anchors across list replacement or
simultaneous live output below the reader. The original native List renderer
remains in use for rich Markdown and cell reuse. The separate review of this
follow-up also finished with no actionable P0–P2 findings after correcting anchor
restoration and interaction cancellation.

Direct tests on the physical iPhone passed keyboard/latest positioning,
long-message reading-position preservation, and repeated sidebar navigation.
The corresponding iPad checks also passed. No new iPhone crash reports appeared
during those final checks. The updated development app was then launched with
its real pairing again.

## Persistent cache and reconnect feedback

The native client now hydrates an encrypted per-pairing rendering cache before
connecting. It retains projects, up to 200 task summaries and five recent history
tails, prioritizing the selected task. Tails are contiguous, bounded to 150 items
and 64 KiB each, and mark omitted history as older. Cache serialization, trimming,
AES-GCM encryption and atomic writes run on a separate actor. Saves are throttled,
flushed on backgrounding, and skip identical content. Streaming tails and optimistic
sends are excluded; the last settled history remains available during a running
turn. Forget invalidates the cache actor and removes its files.

This is disposable presentation state. It restores no replay cursor, sync token,
or active approval. Authoritative snapshots and pages replace cached summaries,
including when a cached timestamp is ahead of the current daemon. A cached
conversation refreshes when opened online and cannot automatically acknowledge
unread activity until fresh history succeeds. Refresh failures leave cached content
readable. Unsent drafts continue to use their separate protected recovery store.

Connection, securing, computer-offline and network-offline states have an explicit
banner. A cold empty sidebar has a centered diamond and caption. A conversation
with cached content keeps its position and shows a floating glass refresh pill
after 350 ms. iPad displays one connection banner while the sidebar is visible;
the detail takes over when that sidebar is hidden. Inline paging retains its own
indicator, avoiding a redundant global paging pill.

Validation: 141 unit tests passed, including cache encryption, identity isolation,
relaunch hydration, size limits, optimistic/streaming exclusion, archive eviction,
clear-versus-save lifetime, and authoritative replacement. All eight loading UI
checks passed on both phone and iPad simulators. The final two cache/banner cases
were rerun on each size after eliminating the duplicate iPad banner. Screenshots
were visually checked; the ignored gallery is `artifacts/cache-2026-10-17/index.html`.

Repo Autoreview (`--mode local --max-priority P2`) passed with no actionable
findings for the feature and the subsequent scoped navigation/cache-clear delta,
using isolated native-only review worktrees so unrelated daemon edits were not
included. The signed Debug app was installed over Wi-Fi on the paired iPhone.
Its first live launch created an encrypted 507 KB cache in the app's own container.
The first use of the new build must populate this cache; later launches can reuse it.
