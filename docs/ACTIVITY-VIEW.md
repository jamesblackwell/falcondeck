# Activity View — implementation plan (handoff)

Status: **planned, not implemented**. Written 2026-08-13 against `main` @ `6fd1641`.
This is a handoff document: it assumes you have not read the codebase yet, and it
front-loads the nuances that will bite you. Line numbers are anchors, not gospel —
`App.tsx` is 4,269 lines and moves; grep for the quoted identifiers.

## 1. What we're building

A core (first-party, always-available) **Activity view**: a Codex-app-style
cross-project attention surface, reachable from a new **"Activity" item at the top
of the sidebar**, rendered as a **full-screen takeover of the main conversation
area** (same pattern as the existing Scheduled view). It aggregates every thread
across every project **and every enrolled remote host** into urgency-ordered
sections, and — the feature Codex doesn't have — lets you **answer approvals and
agent questions inline** without opening the thread.

Sections, in order:

1. **Blocked** — threads with pending interactive requests (approvals first, then
   questions). Each row expands to the real request card with Allow / Deny /
   Always allow or the question's options, answered in place.
2. **Failed** — threads in `error` status that haven't been acknowledged
   (unread). Row shows `last_error`; actions: open thread, mark read.
3. **Ready for you** — finished turns you haven't read (`idle` + unread). Row
   shows `last_message_preview`; actions: open thread, mark read.
4. **Running** — live threads, informational. Row shows `last_tool` ("what it's
   doing right now") and `last_message_preview`.

Explicitly **out of scope for v1** (later ideas, do not build now): streaming
transcript tails in rows (requires widening the `useDaemonConnection` tail
prefetch), the multiplex grid, Zen mode, any daemon or wire-format changes.
**v1 requires zero Rust changes.**

## 2. Where the data comes from (all of it already exists)

- `DaemonSnapshot` carries, for every thread in every workspace:
  `ThreadSummary` (`packages/client-core/src/types.ts:415`) with `status`
  (`idle | running | waiting_for_input | error`), `attention: ThreadAttention`
  (level, `unread`, `pending_approval_count`, `pending_question_count`, read
  cursor), `last_message_preview`, `last_tool`, `last_error`, `latest_plan`,
  `queued_turns`, `updated_at`, `is_archived`, `is_pinned`,
  `is_pinned_in_project`, `provider`.
- `DaemonSnapshot.interactive_requests: InteractiveRequest[]` — **full payloads**
  for all pending approvals/questions across all threads (`types.ts:475`):
  `kind`, `title`, `detail`, `command`, `path`, `approval_decisions`,
  `questions[]` (with options, `is_other`, `is_secret`), `created_at`.
- Attention is computed **daemon-side** per thread on every snapshot
  (`crates/falcondeck-daemon/src/app/threads.rs:1339`,
  precedence `error > awaiting_response > running > unread > none`) and mirrored
  client-side by `deriveThreadAttentionPresentation` in
  `packages/client-core/src/thread-attention.ts`.
- In the desktop app, read **`viewSnapshot`**, not `snapshot`. `viewSnapshot`
  (App.tsx:594) is the local snapshot merged with all enrolled remote hosts via
  `mergeSnapshots(snapshot, remoteHosts.hosts)`. `groups` (App.tsx:728,
  `buildProjectGroups`) is already built from it and is what the sidebar renders.
- The existing seed: `collectAttentionEntries(groups)` in
  `packages/chat-ui/src/components/attention-inbox.tsx` already implements the
  Blocked+Failed collection logic (including the "errors count only until seen"
  acknowledgement rule — read the comments in that file, they encode product
  decisions). We extend this rather than reinvent it.

## 3. File-by-file plan

### 3.1 `packages/client-core/src/activity.ts` — new: the queue selector

The single source of truth for what appears in the view and in what order.
Shared (client-core) so remote-web and mobile can adopt it later.

```ts
export type ActivitySection = 'blocked' | 'failed' | 'ready' | 'running'

export type ActivityEntry = {
  section: ActivitySection
  thread: ThreadSummary
  workspaceId: string
  projectLabel: string           // reuse projectLabel() from grouping.ts
  // Blocked only: pending requests for this thread, oldest first.
  requests: InteractiveRequest[]
  // Stable sort key — see §4.2.
  sortKey: string
}

export function collectActivityEntries(
  groups: ProjectGroup[],
  interactiveRequests: InteractiveRequest[],
): ActivityEntry[]
```

Rules (each is a deliberate decision — keep them):

- Skip `is_archived` threads, same as `collectAttentionEntries`.
- **Blocked**: `attention.pending_approval_count + pending_question_count > 0`,
  *or* the thread has entries in `interactiveRequests`. Use both signals — see
  §4.1. Attach the thread's requests sorted by `created_at` ascending (answer
  oldest first). Approvals sort before questions within the section.
- **Failed**: `level === 'error'` **and** unread. A viewed error is acknowledged
  and drops out (this mirrors `attention-inbox.tsx`; without the unread gate a
  failed thread sits there forever with no way to clear it).
- **Ready**: `status === 'idle'` and unread and not blocked/failed. Note there is
  no `done` status in the model — "finished turn awaiting your reply" *is*
  `idle + unread` (`threads.rs:1060`).
- **Running**: `level === 'running'`. Informational; never shows action buttons.
- A thread appears in exactly one section (first match in the order above).
- **Do not exclude the selected thread.** `AttentionInbox` excludes it to stop
  the sidebar jumping under the user; in a takeover view no conversation is
  visible, so the exclusion would just make the view look broken.

Also export `countActivityEntries(...)` → `{ blocked, failed, ready }` for the
sidebar badge (running is not "attention").

Export from `packages/client-core/src/index.ts`.

### 3.2 `packages/chat-ui/src/components/activity-view.tsx` — new: the view

Lives in chat-ui (not `apps/desktop`) so remote-web can reuse it; it must be
pure-props like `WorkspaceSidebar` (no desktop imports, no `hosts.ts` types —
that is why we do NOT copy `ScheduledTasksView`'s host-manager wiring).

```ts
export type ActivityViewProps = {
  groups: ProjectGroup[]
  interactiveRequests: InteractiveRequest[]
  workspaceHosts?: Record<string, { name: string; connected: boolean }>
  onOpenThread: (workspaceId: string, threadId: string) => void
  onInteractiveResponse: (
    request: InteractiveRequest,
    response: InteractiveResponsePayload,
  ) => Promise<void>          // must reject on failure — the card shows the error
  onMarkThreadRead: (workspaceId: string, threadId: string) => Promise<void> | void
  onClose: () => void          // Esc / back to conversation
}
```

Layout: single scrollable column, max-width ~720px centered (match
`ScheduledTasksView`'s content column), section headers with counts, rows styled
like richer `AttentionInbox` rows (tone dot, title, project label, reason,
relative time). Blocked rows render an embedded
**`InteractiveRequestCard`** (`packages/chat-ui/src/components/interactive-request-card.tsx`) —
reuse it **verbatim**; it already handles approval decision sets
(`approval_decisions` may omit `deny`!), multi-question stepping, secret inputs,
custom answers, submit errors, and a `resolved` display state. Pass
`pendingCount={entry.requests.length}` and the oldest request; when it resolves,
show the next one.

Empty state: full "inbox zero" moment (all caught up, N running quietly) with a
"New thread" affordance if `onNewThread` is provided.

Row rendering notes:

- Rows must be `memo`-ized with an explicit comparator over **rendered fields
  only** — snapshot refreshes recreate every `ThreadSummary` object each poll.
  This is the hard-learned lesson in `thread-item.tsx:~228`
  (`threadRenderEqual`); copy the approach or rows re-render constantly.
- Relative times: copy the `nowTick` pattern from `workspace-sidebar.tsx`
  (60s interval re-render), do not create per-row timers.
- Remote-host threads: show the host badge (`workspaceHosts`), and when
  `connected === false`, disable the respond/mark-read buttons with a tooltip —
  the write would just fail (see §4.5).

### 3.3 Desktop wiring — `apps/desktop/src/App.tsx`

Mirror the Scheduled takeover exactly:

| Change | Anchor |
|---|---|
| `const ActivityView = lazy(...)` | next to `ScheduledTasksView` lazy import, App.tsx:166 |
| `const [isActivityOpen, setIsActivityOpen] = useState(false)` | next to `isScheduledOpen`, App.tsx:281 |
| `handleOpenActivity` callback: opens activity, closes settings + scheduled | next to `handleOpenScheduled`, App.tsx:2907 |
| Close it in **every** selection path: `handleSelectWorkspace` (2545), `handleSelectThread` (2555), `handleNewThread` (2565), `handleOpenSettings` (2900), `handleOpenScheduled` (2907), and the palette/adjacent-thread navigation handlers (~3710/3725 — grep `setIsScheduledOpen(false)` and add the twin everywhere it appears) | — |
| New first branch of the `main` ternary: `isActivityOpen ? <Suspense><ActivityView …/></Suspense> : isScheduledOpen ? …` | App.tsx:3995 |
| Suppress the diff rail: `rail={isSettingsOpen || isScheduledOpen || isActivityOpen ? undefined : <DiffPanel/>}` | App.tsx:4242 |

Props wiring:

- `groups={groups}` and `interactiveRequests={viewSnapshot?.interactive_requests ?? []}`.
  **Do not reuse the existing `interactiveRequests` memo at App.tsx:762** — it is
  filtered to the *selected thread* and is `[]` when none is selected.
- `onInteractiveResponse={handleInteractiveResponseCallback}` (App.tsx:2621) —
  already the right shape `(request, response)`, already routes to the owning
  daemon via `apiFor(workspace_id)` (multi-host safe), already refetches the
  local snapshot on success so counts update, and **rethrows on failure** so the
  embedded card can show the error where the user clicked. Do not swallow.
- `onMarkThreadRead={handleMarkThreadRead}` (App.tsx:3474) — multi-host safe via
  `apiFor`; it reads `last_agent_activity_seq` from `viewSnapshot` itself.
  Caveat: its success path patches only the **local** `snapshot`; for a
  remote-host thread the row clears when that host's event stream refreshes its
  snapshot (~a second). Acceptable for v1; add optimistic row state if it feels
  laggy, not a different API call.
- `onOpenThread`: copy the Scheduled pattern (App.tsx:4006) — close the view,
  set workspace + thread selection.
- `workspaceHosts={workspaceHostBadges}` (App.tsx:602).

### 3.4 Sidebar entry — `apps/desktop/src/components/Sidebar.tsx`

Add `onOpenActivity` / `activityOpen` / `activityCount` to `DesktopSidebarProps`
and render an **Activity button above the Scheduled button** inside the same
`topNavigation` fragment (the slot accepts one node — wrap both buttons in a
fragment; `workspace-sidebar.tsx:1068` renders it inside `<nav className="mb-4">`).
Copy the Scheduled button markup for styling/aria (`aria-current`, `fd-focus`,
active `bg-surface-3`). Icon suggestion: `Activity` from lucide.

Badge: numeric count (blocked + failed + ready), not just a dot — this is the
headline surface. Style like the AttentionInbox count pill
(`bg-warning-muted text-warning`); use danger tone when `failed > 0`.
Compute in App.tsx with `countActivityEntries` over `groups` +
`viewSnapshot.interactive_requests` — do it in a `useMemo`; it runs on every
snapshot churn.

### 3.5 Keyboard shortcut + command palette

- `apps/desktop/src/shortcuts.ts`: add
  `{ id: 'openActivity', label: 'Activity', category: 'App', context: 'global', defaults: ['Mod+Shift+A'] }`
  (check for collisions in that file first; `Ctrl+Shift+A` is taken by
  `openHarnessMenu` — `Mod+Shift+A` (⌘⇧A) is distinct from it (⌃⇧A) but verify
  on the Windows/Linux mapping where Mod = Ctrl collides → pick e.g. `Mod+U`
  like Codex's ⌥⌘U if so).
- App.tsx keydown switch (~3740): add the case calling `handleOpenActivity`.
- `command-palette.tsx`: add an "Open Activity" command next to "Open Settings"
  (prop-driven like `onOpenSettings`).

### 3.6 What happens to `AttentionInbox`

Keep it for v1, unchanged. Once the Activity view has proven itself, a follow-up
can collapse the in-sidebar inbox to nothing and rely on the Activity badge
(calmer sidebar). Removing it in the same PR conflates two behavior changes and
makes the diff hard to evaluate. Do leave a `TODO` in `attention-inbox.tsx`
pointing at this doc.

## 4. The genuinely tricky parts

### 4.1 Two sources of truth for "blocked"

`attention.pending_*_count` (daemon-computed, in `ThreadSummary`) and
`snapshot.interactive_requests` (live list) are updated by different paths and
can disagree for a beat — notably, the Claude provider often leaves
`status: running` while an approval is outstanding, and counts refresh on
snapshot events while the request list also updates via
`interactive-request` events. `deriveThreadAttentionPresentation` already treats
them as fallbacks for each other (`thread-attention.ts:33-48`). The selector
must do the same: a thread is Blocked if **either** signal says so, and if
counts say blocked but no request payload has arrived yet, render the row with a
"Loading request…" placeholder instead of an empty card. Never key the section
off `status === 'waiting_for_input'` — that status is only set reliably by the
ACP/Codex paths.

### 4.2 Row churn and ordering stability

Every snapshot event replaces `ThreadSummary` objects wholesale, and `updated_at`
ticks constantly on running threads. If the sort uses `updated_at`, rows reorder
under the user's cursor mid-click. Rules:

- Sort Blocked by **oldest pending `request.created_at`** (stable — a request's
  creation time never changes), then thread id as tiebreak.
- Sort Failed/Ready by `updated_at` **descending** but treat it as a
  snapshot-at-mount ordering: compute order keys once when the view opens (or
  when a row *enters* a section) and keep them in component state; new arrivals
  append/prepend, existing rows do not reshuffle. A small
  `useStableOrder(entries, keyFn)` hook is enough.
- When a Blocked row is resolved, do not yank it: flip the embedded card to
  `resolved` (the card supports this) for ~1.5s, then remove. If the thread
  immediately re-blocks with the next request, swap the card in place.

### 4.3 Read semantics — do not auto-mark

Opening the Activity view must **not** mark anything read. Scanning a list is
not reading a thread; auto-marking would silently drain the Ready and Failed
sections and defeat the acknowledgement gate on errors. Marking read happens
only (a) via the explicit per-row "Mark read" action, or (b) naturally when the
user opens the thread — the existing effect (App.tsx:~1152) marks the *selected*
thread read while the window is focused, and `onOpenThread` selects the thread.
No new read plumbing needed — just don't add any.

### 4.4 Inline answering vs. the conversation transcript

`handleInteractiveResponse` (App.tsx:2500) patches the resolved request into
`threadDetail.items` *if the responded thread's detail is loaded*, and refetches
the local snapshot. Answering from the Activity view for a thread whose detail
was never fetched is fine — the transcript resolution happens on the daemon and
hydrates on next open. Two things to preserve:

- Rethrow-on-failure: the card's own `submitError` display depends on the
  promise rejecting. Wire the callback straight through.
- After `always_allow`, several queued requests for the same thread may resolve
  server-side at once; the next snapshot refetch reconciles. Don't try to
  predict which requests died — render from the fresh `interactive_requests`.

### 4.5 Remote hosts

`viewSnapshot` merges remote-host snapshots, so their threads and interactive
requests appear automatically, and both write callbacks route via
`apiFor(workspace_id)`. The failure mode is a **disconnected** host: its last
snapshot is stale, its writes fail. Use `workspaceHostBadges[workspaceId].connected`
to (a) show the host name on the row and (b) disable respond/mark-read with a
"Host offline" tooltip. Stale Blocked rows from an offline host should render
dimmed — the request may already be resolved on the other side.

### 4.6 Performance

The badge count and the entries selector run on every snapshot event (which,
with several running threads, is many per second). Both are cheap linear passes;
keep them that way — no `Date.parse` in comparators (precompute), no per-row
`useMemo` chains. `thread_token_usage` is deliberately kept out of `threads` in
the snapshot so usage churn doesn't re-render sidebars — do not add it to
activity rows. The view itself mounts lazily; when closed, the only ongoing cost
must be the badge count memo.

## 5. Testing

Follow existing patterns (vitest + testing-library; note the repo's vitest
configs already carry the Node 26 `execArgv` localStorage fix — reuse them).

- `packages/client-core`: unit tests for `collectActivityEntries` — section
  assignment precedence, both blocked signals (counts-only, requests-only),
  archived exclusion, error-acknowledged exclusion, ordering rules, count
  function. Model fixtures on `normalization.test.ts` helpers.
- `packages/chat-ui`: component tests for `ActivityView` — sections render,
  inline approval calls `onInteractiveResponse` with the right payload,
  rejection shows the card error, resolved-then-removed behavior, mark-read,
  offline-host disabling, empty state. Pattern after
  `Sidebar.test.tsx` / `ContentLifecycle.test.tsx`.
- `apps/desktop`: a takeover-wiring test asserting selection closes the view
  and rail suppression (pattern: `ScheduledTasksView.test.tsx`).
- Manual smoke: `FALCONDECK_STATE_PATH` daemon recipe (see
  `docs/SCHEDULED_TASKS.md` / memory) with two workspaces + one pending approval.

## 6. Follow-ups this deliberately enables (do not build now)

- Sidebar calm-down: remove `AttentionInbox` once the view is trusted.
- Zen mode: a focus presentation over the same `collectActivityEntries` queue.
- Mission Control: widen `useDaemonConnection`'s tail prefetch
  (`useDaemonConnection.ts:540`) from current-workspace to all-visible-cards.
- Extensions Phase 6: once panels exist as an extension point, this view is the
  reference for what a first-party "panel" needs (registry seam at the App.tsx
  `main` ternary).
