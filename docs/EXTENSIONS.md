# FalconDeck Extensions

Status: canonical architecture and implementation plan. The extension runtime
described here is not implemented yet.

This document is the source of truth for code that extends FalconDeck itself.
If implementation conflicts with it, update this document and record the
decision before merging. Wider product context lives in `docs/PLATFORM.md`;
the research behind this design lives in `docs/BB-ANALYSIS.md`.

## 1. Goal

FalconDeck extensions should let a user describe a capability to an agent and
have that agent build, validate, test, and locally enable it without the user
learning FalconDeck internals.

A representative request is:

> Add an extension that lets me tag threads, assign colours to tags, and
> filter the sidebar by tag.

The expected workflow is:

1. The agent reads this document and the extension SDK contract.
2. It scaffolds an extension with the FalconDeck CLI.
3. It implements against typed, named contribution points.
4. It validates the manifest and runs the fake-host tests.
5. It installs the extension from a local path in development mode.
6. FalconDeck shows the user its permissions and enabled state.

Humans provide intent and approve capabilities. Agents author packages. The
manifest, schemas, compiler errors, validation output, fixtures, and examples
are therefore more important than prose alone.

## 2. Terminology

- **Connector**: a tool exposed to an agent, such as an MCP server or skill.
- **Extension**: code that extends FalconDeck itself with UI, state, actions,
  events, automations, or agent-facing tools.
- **Host**: the Deno sidecar supervised by the daemon. It executes extension
  backend code outside the Rust daemon.
- **Contribution**: a declared addition to a named FalconDeck surface.
- **View state**: bounded, non-secret extension data published through the
  daemon for clients to render.
- **Private state**: namespaced extension data that remains daemon-side and is
  never included in ordinary client snapshots.

Use “extension” in code and product UI. “Plugin” is too easily confused with
agent connectors and framework plugins such as Tauri or Expo plugins.

## 3. Non-negotiable rules

1. **The daemon remains the authority.** Installation, enablement, permissions,
   storage, action routing, and synchronized view state belong to the daemon.
2. **Extension code never runs inside the Rust daemon.** The daemon supervises
   a versioned Deno host over JSON-RPC on stdio.
3. **Official extensions use only the public SDK.** Bundling can change source
   and default enablement, but never grants private APIs.
4. **No extension code runs in mobile.** Desktop, web, and mobile initially
   render declarative contributions and synchronized view state.
5. **Permissions are denied by default and enforced by the daemon.** Runtime
   sandboxing is defence in depth, not the product permission boundary.
6. **Extension state never becomes an ad hoc core field.** Use namespaced
   private state or entity-scoped view state.
7. **Unknown contributions degrade visibly.** Old clients preserve data and
   show a fallback rather than crashing or silently discarding it.
8. **Wire contracts are versioned and machine-checked.** Rust owns daemon
   protocol types; generated TypeScript and JSON Schema are published.
9. **One faulty extension fails alone.** Activation, actions, events, and
   shutdown have timeouts, size limits, and independent failure state.
10. **Extensions do not replace core data ownership.** Agent sessions remain
    owned by their harnesses; extensions may annotate and act on entities.

## 4. Repository and package layout

The target monorepo shape is:

```text
apps/
  extension-host/                # Deno supervisor and extension isolates
crates/
  falcondeck-extension-protocol/ # daemon <-> host types, if core grows too large
extensions/
  official/
    thread-tags/
    notepad/
  examples/
    hello-panel/
  catalog.json                   # FalconDeck-owned bundling/default policy
packages/
  extension-sdk/                 # public authoring API
  extension-testing/             # fake host, fixtures, assertions
schemas/
  extension-manifest.schema.json # generated and checked in for tooling
```

An authored extension is deliberately small:

```text
thread-tags/
  falcondeck.extension.json
  server.ts
  ui.ts                          # optional declarative helpers
  README.md
  tests/
```

Packages may contain assets and migrations. They may not import source files
from `apps/`, `crates/`, or private `packages/` paths. CI enforces the same rule
for official extensions.

`extensions/catalog.json` is distribution policy owned by FalconDeck. It says
which official packages are bundled and enabled on fresh installation. An
extension cannot declare itself trusted or default-enabled in its manifest.

Initial policy:

- `falcondeck.thread-tags`: bundled and enabled by default.
- `falcondeck.notepad`: bundled but disabled by default once implemented.

## 5. Manifest contract

Every package contains `falcondeck.extension.json`, validated before code loads:

```json
{
  "$schema": "https://falcondeck.com/schemas/extension-manifest-v1.json",
  "id": "falcondeck.thread-tags",
  "name": "Thread Tags",
  "version": "1.0.0",
  "engines": { "falcondeck": "^1" },
  "entrypoint": "server.ts",
  "contributes": {
    "threadMenuActions": [{ "id": "manage-tags", "title": "Manage tags" }],
    "threadDecorations": [{ "id": "tag-chips", "view": "thread-tags" }],
    "sidebarFilters": [{ "id": "tags", "title": "Tags", "view": "tag-index" }]
  },
  "permissions": []
}
```

Required properties are a globally unique reverse-domain-style id, name,
semantic version, supported extension API range, optional backend entrypoint,
declared contributions, and requested permissions with reasons when sensitive.

Paths are package-relative, cannot traverse, and must resolve beneath the
installed root. Unknown required fields fail validation. Unknown optional
properties are preserved for forward compatibility.

Contribution identifiers are durable. Renaming an action, view, or setting
requires an alias or migration because saved state may refer to it.

## 6. Public SDK

The TypeScript SDK exposes capability-shaped facets, never daemon transport or
internal React stores:

```ts
export default defineExtension({
  async activate(context) {
    context.actions.register("manage-tags", async invocation => {
      const tags = await context.storage.get<Tag[]>("tags", []);
      // Return a declarative form or process submitted form data.
    });
  },
});
```

Initial `ExtensionContext` facets:

| Facet | Purpose |
| --- | --- |
| `extension` | Identity, installed version, API version, lifecycle signal |
| `log` | Structured, attributed diagnostics with redaction |
| `storage` | Namespaced private storage and transactions |
| `views` | Publish bounded synchronized state declared by the manifest |
| `actions` | Handle invocations from declared UI actions |
| `events` | Subscribe to permitted daemon lifecycle events |
| `threads` | Permission-gated thread reads and annotations |
| `commands` | Register declared slash or command-palette commands |

Later facets may add schedules, notifications, agent tools, turn control,
workspace files, and mediated network access. Plausibility alone does not put a
facet into v1.

Every registration returns a disposable. The host disposes resources in
reverse order when an extension is disabled, reloaded, or replaced.

## 7. State and synchronization

Extensions have two intentionally separate forms of state.

### Private state

Private state is daemon-owned, namespaced by extension id, and exposed only
through `context.storage`. It supports JSON values with size limits, atomic
transactions or compare-and-swap, schema versions and ordered migrations,
retention while disabled, and separate confirmation before data deletion.

Secrets do not use ordinary storage. A later secrets capability must use
platform credential storage and opaque handles where practical.

### View state

View state is non-secret data intended for clients:

```ts
await context.views.publish({
  view: "thread-tags",
  scope: { kind: "thread", id: threadId },
  value: { tags: [{ id: "urgent", label: "Urgent", color: "red" }] },
});
```

The daemon validates and persists the latest projection, includes relevant
bounded projections in snapshots/detail responses, and emits sequenced updates
through the existing event stream. Relay encryption and replay work without a
second extension transport.

Views have per-view and per-entity limits. Large data is fetched on demand,
not placed in every snapshot. This split lets clients render tags or notepad
summaries while the host restarts without broadcasting private data.

## 8. Declarative UI

The first API provides named contribution points:

- thread context-menu actions;
- thread badges and decorations;
- sidebar filters;
- header and composer actions;
- command-palette and slash commands;
- settings sections;
- conversation cards;
- standalone panels.

Only the first three plus declarative modal/form UI are required for Thread
Tags.

Contributions bind manifest declarations to view state and actions. Clients
render a versioned JSON vocabulary: stack, row, text, icon, divider, button,
menu, list, input, select, colour picker, Markdown, and standard loading,
empty, and error states.

The vocabulary supplies accessibility and keyboard semantics, theme tokens,
localization-ready strings, and validation without extension-authored CSS.
Bindings are data, not executable expressions.

Sandboxed webviews are a later desktop/web escape hatch. Mobile always needs a
useful declarative or generic fallback. Whole-region replacement, same-origin
scripts, arbitrary CSS, and direct store access are out of scope for v1.

## 9. Runtime and lifecycle

```mermaid
flowchart LR
    P["Extension package"] --> H["Deno extension host"]
    H <-->|"versioned JSON-RPC over stdio"| D["FalconDeck daemon"]
    D --> L["Desktop/local clients"]
    D --> R["Encrypted relay"]
    R --> W["Remote web"]
    R --> M["Mobile"]
```

The daemon owns this lifecycle:

1. Discover bundled and user-installed manifests.
2. Validate paths, compatibility, and recorded grants.
3. Start the host when an executable extension is enabled.
4. Send the enabled catalog and capability grants.
5. Wait for activation and contribution registration.
6. Publish status and contributions to clients.
7. Route actions and permitted events through the host.
8. Dispose on disable, upgrade, shutdown, or host restart.

The host is a supervisor. Each extension executes in its own isolate or worker
with independent status, limits, and runtime permissions. The Deno isolation
primitive may evolve without changing the daemon-host contract.

Host restart uses bounded exponential backoff. Repeated failure suspends
execution for the session and surfaces repair UI; it does not erase state. A
failed upgrade leaves the previous working package active.

## 10. Permissions and trust

Baseline capabilities need no prompt because they cannot reach user data beyond
the invocation context: identity, diagnostics, own storage, declared bounded
views, declared actions with a FalconDeck-supplied target, and declared UI.

Broader access is explicit and granular. Planned families are:

- `threads:read` and `threads:annotate`;
- `turns:start`, `turns:steer`, and `turns:interrupt`;
- `workspaces:read` and `workspace-files:read|write`;
- `network:<origin>`;
- `notifications:send`;
- `agent-tools:register`;
- lifecycle event subscriptions by event family.

The daemon checks every operation, not only activation, and reduces event
payloads to granted fields. Permission increases suspend an upgrade until the
user approves them.

Bundled means distributed by FalconDeck, not unrestricted. Default-enabled
official extensions stay within baseline capabilities unless the product has
an explicit first-run consent design.

## 11. Installation and enablement

The first supported sources are bundled packages, a local development
directory, and a packed local archive with a digest. Git and registry installs,
signatures, provenance, automatic updates, and a marketplace follow after the
local contract stabilizes.

Settings shows source, version, status, permissions, enable/disable control,
diagnostics, and data-removal control. Disabling retains data. Uninstalling code
and deleting data are separate operations.

Enablement is daemon-scoped initially so all paired clients see one coherent
feature set. Per-workspace enablement may come later without changing packages.

## 12. Agent authoring experience

The CLI is the corrective interface for extension-building agents:

```bash
falcondeck extension create thread-tags
falcondeck extension validate ./thread-tags --json
falcondeck extension test ./thread-tags --json
falcondeck extension dev ./thread-tags --json
falcondeck extension pack ./thread-tags --json
```

Commands provide stable JSON diagnostics with codes, file paths, JSON pointers,
and suggested repairs. Human output is a projection of the same diagnostics.

The scaffold contains the smallest valid manifest, typed lifecycle, a fake-host
test, fixtures for selected contributions, and an extension-local `AGENTS.md`
pointing here. It adds no unrelated placeholder dependencies.

The SDK exports types and builders. The manifest schema powers completion. The
test package provides a fake daemon, permission grants, time control, action
invocation, rendering fixtures, and failure injection.

Canonical starter prompt:

> Build a FalconDeck extension in this repository. Read
> `docs/EXTENSIONS.md`, scaffold it with `falcondeck extension create`, use
> only the public extension SDK, run validation and fake-host tests, test every
> contribution on supported clients, and list requested permissions before
> enabling it.

## 13. First official extension: Thread Tags

Thread Tags is bundled and enabled by default. An empty tag set produces no UI
clutter. It is both useful and the acceptance test for the architecture.

Initial behaviour:

- Create, rename, recolour, reorder, and delete tags.
- Attach zero or more tags from a thread context menu.
- Show compact coloured tag indicators in thread rows.
- Filter the sidebar by one or more tags.
- Preserve definitions and assignments across restart.
- Keep desktop, remote web, and mobile consistent through daemon snapshots and
  sequenced updates.
- Render tags read-only when a client cannot edit them.

Definitions live in private storage. Per-thread assignments and the small tag
index needed by filters are view state. Deleting a tag removes assignments
transactionally. Rename and recolour do not rewrite assignments because they
refer to stable tag ids.

Required contributions:

- `threadMenuActions.manage-tags`
- `threadDecorations.tag-chips`
- `sidebarFilters.tags`
- a declarative manage-tags form

Acceptance gate:

- no private import or special daemon method;
- disabling removes UI immediately but retains data;
- reenabling restores data without restart;
- a host crash leaves the last synchronized display available;
- permission denial fails closed and explains the unavailable action;
- snapshot plus replay convergence works on desktop, web, and mobile;
- malformed or oversized view state is safely rejected;
- the same SDK can build an equivalent third-party extension.

## 14. Implementation plan

Each phase ends in a tested contract. Do not broaden contributions before the
preceding gate is satisfied.

### Phase 0 — contract and repository skeleton

Deliver:

- this document and architecture cross-links;
- manifest v1 Rust/TypeScript types and generated JSON Schema;
- `packages/extension-sdk` identity and lifecycle types;
- `packages/extension-testing` skeleton;
- Thread Tags scaffold and official catalog entry;
- compatibility and diagnostic-code conventions.

Gate:

- a fixture validates identically in Rust, TypeScript, and CLI;
- official packages cannot import private workspace modules;
- CI detects generated schema drift.

### Phase 1 — daemon registry, storage, and protocol

Deliver:

- bundled and local-path discovery;
- persisted install, enabled, version, source, status, and permission records;
- transactional private storage with migrations;
- bounded entity-scoped view state;
- catalog and projections in snapshot/detail contracts;
- sequenced catalog/view events;
- generic `extension.action.invoke` and query RPCs;
- dynamic RPC registration shared by local and relay transports.

Gate:

- state survives restart and unknown data survives read-write cycles;
- local and paired clients converge after snapshot, replay, and replay pruning;
- disabled extensions receive no actions or events;
- Rust enforces every permission and limit.

### Phase 2 — Deno host and SDK execution

Deliver:

- supervised host with a versioned JSON-RPC handshake;
- per-extension activation, isolation, disposal, timeout, and diagnostics;
- SDK implementations for log, storage, views, actions, and lifecycle;
- transactional development reload;
- host packaging in desktop and standalone daemon distributions.

Gate:

- throwing or hanging fixtures cannot affect another extension or daemon RPCs;
- restart preserves private and last-published view state;
- failed upgrade retains the previous version;
- releases need no separately installed Deno runtime.

### Phase 3 — declarative UI and settings

Deliver:

- versioned component and action-binding schema;
- shared web renderer in `packages/chat-ui`;
- mobile renderer for the v1 vocabulary;
- thread menu, decoration, sidebar filter, and modal/form hosts;
- Extensions settings and local-path installation;
- generic unsupported-contribution fallback.

Gate:

- accessibility and keyboard tests cover every primitive;
- desktop, remote web, and mobile render common fixtures coherently;
- an older client preserves state and shows an inspectable fallback;
- disabling disposes UI without a client reload.

### Phase 4 — Thread Tags vertical slice

Deliver section 13 using only public SDK facets, enabled by default in the
official catalog.

Gate:

- daemon, relay, desktop, remote-web, and mobile integration tests pass;
- install/disable/enable/upgrade/restart/crash scenarios pass;
- a clean checkout can validate, test, and pack it with documented commands;
- repo-local autoreview is clean before shipping.

### Phase 5 — agent authoring release

Deliver:

- `create|validate|test|dev|pack` CLI commands;
- stable JSON diagnostics and repairs;
- generated public SDK reference;
- a minimal example distinct from Thread Tags;
- an end-to-end fresh-scaffold test;
- public starter prompt and contribution checklist.

Gate:

- another coding harness builds a small extension using only repository docs
  and command output;
- validation catches missing permissions, invalid bindings, incompatible API
  versions, unsafe paths, private imports, and untested contributions.

### Phase 6 — expand from demonstrated demand

Candidates include standalone panels for Notepad, settings, conversation cards,
automations, agent tools, schedules, and notifications. Each new capability
needs a permission, limits, fake-host support, client fallback, and official or
example consumer.

Do not begin marketplace, signing, arbitrary webviews, whole-region UI
replacement, extension dependencies, or cross-extension calls until local
packages and Thread Tags exercise compatibility in real use.

## 15. Required test layers

Every capability needs all applicable layers:

1. Schema and compatibility tests.
2. SDK tests against the fake host.
3. Daemon permission, persistence, migration, and limit tests.
4. Host isolation, lifecycle, timeout, reload, and crash tests.
5. Shared renderer contract fixtures.
6. Desktop, remote-web, and mobile presentation tests.
7. Snapshot, replay, reconnect, and replay-pruning convergence tests.
8. Packaged desktop and standalone daemon smoke tests.
9. An official or example extension using no private APIs.

An SDK feature without fake-host support is incomplete. A UI contribution
without a mobile fallback is incomplete. A daemon operation without permission
and size limits is incomplete.

## 16. Compatibility policy

- API major versions are explicit in manifests and the host handshake.
- Additive optional fields are minor-compatible and preserved by readers.
- Removing or changing semantics requires a new major version.
- Contribution and view ids are persisted API, not display strings.
- Data migrations are extension-owned, ordered, transactional, and tested.
- FalconDeck may suspend incompatible code but keeps its record and data.
- Generic view/action envelopes remain readable when an extension is absent.

During initial development the API may be `0.x`, but breaking changes still
update fixtures, schemas, official extensions, and this document together.

## 17. Drift prevention checklist

Before changing the extension API, answer:

- Is this a connector feature or a FalconDeck extension feature?
- Can an official extension implement it without a private import?
- Is the daemon still authoritative for permissions, storage, and routing?
- Is data correctly split between private and bounded view state?
- Is the contribution named and declarative where possible?
- What happens on mobile and on an older client?
- What happens on host crash, extension hang, disable, and failed upgrade?
- Are wire types and schemas generated and versioned?
- Does the fake host expose the same behaviour?
- Which official or example extension proves the API?

If these questions lack concrete answers, the capability is not ready for the
public extension SDK.
