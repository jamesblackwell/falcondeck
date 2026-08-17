# BB side chats and browser

This document maps the two BB features that are easy to conflate:

- **Side chat is shipped.** It is a first-party plugin built on ordinary BB
  threads, forks, panel tabs, and queued messages.
- **The browser is only partly shipped.** BB has a desktop in-app browser for
  users. Agent-controlled browser automation is described in
  `plans/bb-browser.md`, but is explicitly not started in the inspected source
  snapshot.

References below point at `get-bb/bb` commit [`ba42654`](https://github.com/get-bb/bb/tree/ba42654), the checkout inspected for this analysis.

## Side chats

### The data model

BB deliberately does not make side chat a new thread type or a second
conversation store. A side chat is an ordinary thread fork with three pieces of
metadata:

```text
originKind:     "fork"
originPluginId: "side-chat"
visibility:     "hidden"
```

The plugin source documents this model at
[`plugins/side-chat/server.ts:1-9`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L1-L9). The domain module says that the former
native `side-chat` origin kind was replaced by the plugin-owned hidden fork
model ([`packages/domain/src/thread-origin-kind.ts:10-15`](https://github.com/get-bb/bb/blob/ba42654/packages/domain/src/thread-origin-kind.ts#L10-L15)); migration 0084 converts existing rows ([`packages/db/drizzle/0084_side_chat_plugin_only.sql:3-26`](https://github.com/get-bb/bb/blob/ba42654/packages/db/drizzle/0084_side_chat_plugin_only.sql#L3-L26)).

The plugin is enabled by default in the built-in registry
([`apps/server/src/services/plugins/builtin-registry.ts:88-92`](https://github.com/get-bb/bb/blob/ba42654/apps/server/src/services/plugins/builtin-registry.ts#L88-L92)).

### Creation flow

```text
message action / panel launcher
        |
        v
side-chat app action
        |  POST /api/v1/plugins/side-chat/rpc/createSideChat
        v
side-chat server plugin
        |  read source timeline and resolve anchor
        |  fork source thread
        v
hidden side-chat thread (idle)
        |
        v
plugin panel tab renders host ThreadChat
```

The frontend exposes two entry points ([`plugins/side-chat/app.tsx:310-343`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/app.tsx#L310-L343)):

1. **Reply in side chat** from a message or selected text.
2. **Start side chat** from the thread panel launcher, which forks from the
   current tip without an anchor.

The action calls the plugin RPC directly because host action callbacks are not
React components and therefore cannot use the plugin `useRpc` hook
([`plugins/side-chat/app.tsx:64-98`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/app.tsx#L64-L98)). A single-flight map prevents a double click from creating duplicate
hidden forks ([`plugins/side-chat/app.tsx:118-151`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/app.tsx#L118-L151)).

The backend then:

1. Reads the source timeline with nested rows.
2. Decides whether the selected/message text needs to be preserved as an
   anchor.
3. Forks the source thread, optionally at `sourceSeqEnd`.
4. Returns the new thread id to the frontend.

This is implemented in the RPC contract and handler at
[`plugins/side-chat/server.ts:146-225`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L146-L225).

### Anchor handling

The fork already contains the source conversation history, so BB does not
repeat the latest message by default. `resolveReplySeedText` returns no seed
when the anchor is empty or equals the source's latest conversation message;
an explicit older selection is retained ([`plugins/side-chat/server.ts:41-91`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L41-L91)).

When needed, the plugin adds an agent-only context seed:

```text
Replying to this earlier message in the conversation:

<anchor text>
```

The seed is deliberately `agent-only`, so the model gets the pointer without
the user seeing an artificial message in the side-chat transcript
([`plugins/side-chat/server.ts:187-207`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L187-L207)).

The fork uses `workspace: "reuse"`, not an isolated worktree. BB treats a side
chat as an aside about the source thread's current work; a fresh worktree could
show stale files ([`plugins/side-chat/server.ts:187-195`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L187-L195)). If a historical `sourceSeqEnd` has no provider session snapshot, the plugin retries a tip fork, but only for the structured
`fork_source_session_unavailable` error ([`plugins/side-chat/server.ts:209-225`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L209-L225)).

### Panel and conversation behavior

The panel stores both the new side-chat thread id and its source/anchor in
persisted JSON params. It renders the normal host-owned `ThreadChat` in compact,
contained mode, with an editable permission picker and a `Replying to` header
([`plugins/side-chat/app.tsx:31-62`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/app.tsx#L31-L62), [`plugins/side-chat/app.tsx:247-305`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/app.tsx#L247-L305)). The plugin therefore gets a specialized surface without reimplementing the chat runtime.

An assistant message in the side chat has a **Send to main thread** action. It
does not directly inject text into an active turn. Instead, the plugin creates a
queued message on the source thread and includes the side-chat thread id as
`senderThreadId` ([`plugins/side-chat/server.ts:163-173`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L163-L173), [`plugins/side-chat/server.ts:227-234`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L227-L234)). The main thread can then consume that queued input using the normal thread machinery while retaining provenance.

### Visibility and cleanup

Hidden forks are identified by all of `originKind`, `originPluginId`,
`visibility`, and `archivedAt` ([`plugins/side-chat/server.ts:133-144`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L133-L144)). An hourly plugin cron archives only forks that are:

- older than 24 hours;
- missing a user message; and
- missing queued messages.

Timeline and queued-message reads fail closed: an error leaves the fork in
place for the next sweep. Once a fork is found to contain user work, a namespaced
KV key remembers that decision so it is not repeatedly scanned
([`plugins/side-chat/server.ts:22-27`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L22-L27), [`plugins/side-chat/server.ts:237-296`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L237-L296), [`plugins/side-chat/server.ts:298-348`](https://github.com/get-bb/bb/blob/ba42654/plugins/side-chat/server.ts#L298-L348)). This is archival cleanup, not deletion of a conversation that someone used.

### Side-chat summary

BB's side chat is a thin product feature over durable primitives:

```text
plugin action
  -> typed plugin RPC
  -> ordinary thread fork
  -> hidden/plugin-owned metadata
  -> host ThreadChat panel
  -> queued cross-thread handoff with sender provenance
  -> fail-closed archival of abandoned empty forks
```

The important design choice is that side chat is not an agent tool and not an
alternate transcript database. It is a normal provider-backed thread with a
small amount of plugin policy around creation, presentation, and handoff.

## Browser

### What is shipped today

The shipped browser is a **desktop-only, user-facing in-app browser**. It is a
secondary-panel tab backed by Electron `WebContentsView`; it is not currently a
browser tool exposed to agents.

The tab metadata is a normal fixed-panel tab with an id, URL, title, and
environment id. The live loading state is kept by the active tab rather than
persisted ([`apps/app/src/lib/fixed-panel-tabs-state.ts:240-254`](https://github.com/get-bb/bb/blob/ba42654/apps/app/src/lib/fixed-panel-tabs-state.ts#L240-L254)). BB persists panel/tab state through the host's thread-tab machinery, while the native view is created lazily for the active tab. `BrowserTabDeck` explicitly mounts only the selected tab and keeps inactive persisted tabs as metadata ([`apps/app/src/components/secondary-panel/BrowserTabDeck.tsx:42-75`](https://github.com/get-bb/bb/blob/ba42654/apps/app/src/components/secondary-panel/BrowserTabDeck.tsx#L42-L75)).

The user-facing path is:

```text
link / browser launcher
        |
        v
openUrlByPreference + browser tab state
        |
        v
BrowserTabContent (React chrome and layout measurement)
        |
        v
preload browser API / typed IPC
        |
        v
desktop main process
        |
        v
Electron WebContentsView
        |
        v
navigation state, popup requests, resize snapshot -> renderer
```

`BrowserTabContent` attaches a native view, subscribes to navigation state and
resize snapshots, and continuously sends renderer-measured bounds to the main
process ([`apps/app/src/components/secondary-panel/BrowserTabContent.tsx:501-615`](https://github.com/get-bb/bb/blob/ba42654/apps/app/src/components/secondary-panel/BrowserTabContent.tsx#L501-L615), [`apps/app/src/components/secondary-panel/BrowserTabContent.tsx:628-710`](https://github.com/get-bb/bb/blob/ba42654/apps/app/src/components/secondary-panel/BrowserTabContent.tsx#L628-L710)). The browser API is intentionally a narrow, strict wire contract for attach, navigate, visibility, bounds, state, popup tabs, and resize snapshots ([`packages/desktop-contract/src/browser.ts:89-274`](https://github.com/get-bb/bb/blob/ba42654/packages/desktop-contract/src/browser.ts#L89-L274)).

The renderer-to-main IPC handlers parse every request and derive the host window
from the sending `webContents`, which keeps commands scoped to the correct
desktop window ([`apps/desktop/src/desktop-browser-main-ipc.ts:34-118`](https://github.com/get-bb/bb/blob/ba42654/apps/desktop/src/desktop-browser-main-ipc.ts#L34-L118)).

### Native view isolation and lifecycle

Each tab is a `WebContentsView` in the persistent but separate
`persist:bb-browser` session. The browser session does not share cookies/storage
with BB's app session or the user's normal browser
([`apps/desktop/src/desktop-browser-view.ts:50-54`](https://github.com/get-bb/bb/blob/ba42654/apps/desktop/src/desktop-browser-view.ts#L50-L54)). The manager retains views while tabs are inactive, hides them when not selected, and destroys them when detached or their host window is released.

The renderer is the placement authority: it measures the panel, the desktop
main process clamps those bounds to the live content area, and a temporary JPEG
snapshot hides the independently composited native view during window resize.
The bounds and resize behavior are described in
[`packages/desktop-contract/src/browser.ts:12-87`](https://github.com/get-bb/bb/blob/ba42654/packages/desktop-contract/src/browser.ts#L12-L87) and [`apps/desktop/src/desktop-browser-view.ts:162-191`](https://github.com/get-bb/bb/blob/ba42654/apps/desktop/src/desktop-browser-view.ts#L162-L191).

### Browser security boundaries

The native browser has several deliberate boundaries:

- No BB preload bridge is exposed to the untrusted page; page code is not given
  the app's API.
- Device permissions are denied except write-only sanitized clipboard access;
  clipboard reads, camera, microphone, geolocation, notifications, and similar
  capabilities remain blocked ([`apps/desktop/src/desktop-browser-view.ts:274-283`](https://github.com/get-bb/bb/blob/ba42654/apps/desktop/src/desktop-browser-view.ts#L274-L283)).
- Downloads are prevented and native pop-up windows are denied. Allowed
  `window.open`/`target=_blank` requests are surfaced as in-panel tabs, with a
  sliding popup rate limit ([`apps/desktop/src/desktop-browser-policy.ts:19-65`](https://github.com/get-bb/bb/blob/ba42654/apps/desktop/src/desktop-browser-policy.ts#L19-L65)).
- Top-level navigation is restricted to `http:` and `https:` schemes
  ([`apps/desktop/src/desktop-browser-policy.ts:4-17`](https://github.com/get-bb/bb/blob/ba42654/apps/desktop/src/desktop-browser-policy.ts#L4-L17)).
- URL, title, state, and snapshot payloads have explicit size caps at the IPC
  boundary ([`packages/desktop-contract/src/browser.ts:1-10`](https://github.com/get-bb/bb/blob/ba42654/packages/desktop-contract/src/browser.ts#L1-L10), [`packages/desktop-contract/src/browser.ts:197-223`](https://github.com/get-bb/bb/blob/ba42654/packages/desktop-contract/src/browser.ts#L197-L223)).

At this snapshot, the navigation policy is a scheme/popup policy rather than a
private-network firewall: explicit `http(s)` loopback and LAN URLs are allowed
by `resolveWindowOpenAction`. The address-bar input helper may treat bare
private hosts as search text, but that is separate from the native navigation
policy.

The web build has no native browser view; the app tells users that browser tabs
require the desktop app ([`apps/app/src/components/secondary-panel/BrowserTabContent.tsx:355-377`](https://github.com/get-bb/bb/blob/ba42654/apps/app/src/components/secondary-panel/BrowserTabContent.tsx#L355-L377)). Links can be routed in-app or externally according to the
`bb.openLinksInAppBrowser` preference ([`apps/app/src/lib/in-app-browser-link-preference.ts:1-82`](https://github.com/get-bb/bb/blob/ba42654/apps/app/src/lib/in-app-browser-link-preference.ts#L1-L82)).

## Browser automation is a separate, future feature

`plans/bb-browser.md` states that browser automation was **not started** in the
source snapshot: there is no `apps/cli/src/commands/browser.ts` and no
`bb-browser` built-in skill ([`plans/bb-browser.md:1-18`](https://github.com/get-bb/bb/blob/ba42654/plans/bb-browser.md#L1-L18)). Therefore the current browser does not let an agent inspect a page, click a selector, type into a form, evaluate JavaScript, or control a user's existing tab through BB's own runtime.

The planned architecture is intentionally scoped and does not use a production
Electron remote-debugging port:

```text
bb browser CLI
  -> server browser automation API
  -> active desktop request channel
  -> renderer opens/focuses a visible browser tab
  -> renderer registers an automation-owned target
  -> desktop main drives that WebContentsView through CDP/Electron APIs
  -> result returns to server and CLI
```

This is the plan's architecture diagram and ownership boundary
([`plans/bb-browser.md:39-85`](https://github.com/get-bb/bb/blob/ba42654/plans/bb-browser.md#L39-L85)). Planned targets carry `targetId`, `threadId`, creator, visibility, and timestamps; server authorization and cancellation happen before dispatch; automation cannot target arbitrary user tabs ([`plans/bb-browser.md:87-147`](https://github.com/get-bb/bb/blob/ba42654/plans/bb-browser.md#L87-L147)).

The proposed command surface is ordinary CLI, with JSON output for agents:

```bash
bb browser open <url> --visible --json
bb browser snapshot <target-id> --json
bb browser click <target-id> --selector 'button[type=submit]'
bb browser type <target-id> --selector '#email' --text 'user@example.com'
bb browser eval <target-id> --script-file script.js --json
bb browser close <target-id>
```

Those commands, the renderer registration step, and the future built-in skill
are specified in [`plans/bb-browser.md:49-66`](https://github.com/get-bb/bb/blob/ba42654/plans/bb-browser.md#L49-L66), [`plans/bb-browser.md:154-231`](https://github.com/get-bb/bb/blob/ba42654/plans/bb-browser.md#L154-L231), and [`plans/bb-browser.md:238-264`](https://github.com/get-bb/bb/blob/ba42654/plans/bb-browser.md#L238-L264). The plan recommends CLI first and thin dynamic-tool wrappers later, so it does not require browser-specific MCP tools.

## Takeaways for FalconDeck

### Side chat

The reusable pattern is:

1. Represent the aside as a normal daemon/provider thread fork.
2. Attach explicit source, origin, and visibility metadata.
3. Reuse the source environment when the aside discusses current files.
4. Put anchor text in agent-only context when the fork already has the source
   history.
5. Present the fork in a normal chat component rather than a second transcript
   system.
6. Hand results back as queued, provenance-bearing cross-thread messages.
7. Archive only untouched empty forks, fail closed on read errors.

This fits FalconDeck's daemon-first model better than adding a separate side-chat
database. The analogous places to study in FalconDeck are the thread creation
and queued-message contracts in `crates/falcondeck-core` and
`crates/falcondeck-daemon`, rather than the OpenCode provider adapter.

### Browser

Separate the user browser surface from agent automation. A BB-style automation
implementation would need:

- a server/daemon target registry scoped to host and thread;
- an explicit request/response channel to the desktop shell;
- renderer registration of only automation-owned tabs;
- a desktop-native driver (CDP or an equally scoped bridge);
- cancellation, ownership checks, size limits, and an auditable `eval` path;
- a CLI contract that agents can use without provider-specific tools;
- a skill documenting the CLI after the underlying commands exist.

The key security lesson is not to expose a broad Electron debugging endpoint:
the BB plan calls out that this could expose trusted BB UI targets and instead
prefers a scoped bridge ([`plans/bb-browser.md:39-47`](https://github.com/get-bb/bb/blob/ba42654/plans/bb-browser.md#L39-L47)).
