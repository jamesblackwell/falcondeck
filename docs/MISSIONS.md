# Missions

Status: implemented product and architecture specification.

`docs/EXTENSIONS.md` remains the source of truth for the extension contract.
`docs/SCHEDULED_TASKS.md` and `docs/AGENT-CONTROL.md` remain the source of truth
for Automation execution. This document defines how the Missions extension
combines those existing primitives without becoming another agent runtime.

## 1. Product decision

A Mission is a durable project brief for work that may span many agent tasks,
models, schedules, and long periods of inactivity.

It is not:

- a long-running agent process;
- a special kind of provider conversation;
- an expiring lease;
- a replacement for Codex or Claude goals;
- a requirement to use multiple agents; or
- a second scheduler.

The simplest useful definition is:

> Mission = brief + status + updates + linked tasks.

Native agent tasks and Goals perform the work. FalconDeck Automations decide
when an agent should check the Mission again. The Mission keeps the durable
purpose, evidence, human decisions, and task relationships legible when any
single conversation becomes stale, compacted, replaced, or forgotten.

This separation is the reason Missions is useful even though a carefully
prompted agent and a recurring Automation could approximate the behaviour.
Without a Mission, the project exists only implicitly across prompt history,
scheduled-task definitions, and unrelated sidebar entries. It has no stable
status, success criteria, shared update log, attention state, or place for a
human to return after weeks away.

## 2. User model

A user can discover a larger piece of work in any ordinary conversation and
ask the agent to create a Mission. That task becomes the first linked task, not
a permanent coordinator.

Once the user and agent agree the brief, creating the Mission starts it. The
same operation saves the Mission, schedules its recurring check-in, and queues
the first agent check-in immediately. After that:

- agents post progress, evidence, questions, and status changes to the Mission;
- FalconDeck shows every linked native task and Mission-owned Automation;
- a scheduled review can reuse a suitable linked task or create a fresh one;
- the user can add guidance at any time through the Mission page;
- a human explicitly accepts completion or cancels the Mission; and
- a Mission can remain active for months while consuming no model resources
  between reviews.

The UI calls provider-backed conversations **tasks**, matching FalconDeck and
Codex product language. The code and transport may continue to use `thread`.

## 3. Why Goals and Automations are not enough

Harness-native Goals are excellent for one agent pursuing one objective inside
one task. Some can already run for hours or days. Missions should not compete
with that.

Use a Goal when one task can retain ownership and make continuous progress.
Use a Mission when the durable unit of work must outlive or coordinate several
tasks, wait for external events, collect human decisions over time, or remain
visible after its current agent task is no longer useful.

Automations provide durable timing and execution, but they intentionally do not
provide project structure. A Mission adds the missing association:

- which Automations serve the same outcome;
- which tasks belong to that outcome;
- what success means;
- what changed since the last review;
- whether a human is needed; and
- whether the work is still active, paused, under review, or complete.

Missions therefore reuse Automations rather than duplicating their timers,
dispatch, provider settings, permissions, run history, concurrency, misfire,
and restart semantics.

## 4. Canonical data model

The extension stores the following entity:

```ts
type MissionStatus =
  | "active"
  | "waiting"
  | "needs_human"
  | "review"
  | "paused"
  | "completed"
  | "cancelled";

type Mission = {
  id: string;
  title: string;
  brief: string;
  successCriteria: string[];
  status: MissionStatus;
  deadline?: string;
  threads: MissionThreadLink[];
  updates: MissionUpdate[];
  createdAt: string;
  updatedAt: string;
};

type MissionThreadLink = {
  workspaceId: string;
  threadId: string;
  role: "source" | "work" | "review";
  linkedAt: string;
};

type MissionUpdate = {
  id: string;
  actor: "human" | "agent" | "system";
  kind: "comment" | "evidence" | "question" | "status";
  body: string;
  threadId?: string;
  createdAt: string;
};
```

The entity deliberately does not duplicate Automation configuration. It has no
review-agent, model, prompt, next-review time, thread strategy, permission mode,
concurrency policy, or list of Automation ids. Those fields belong to the
owned Automation and are queried by owner.

The entity also has no Mission work-item type in the first version. Linked
agent tasks are the work items, native Goals are their objectives, and
Automations are future checks. Add virtual work items only if real usage shows
that agents need planned items before a native task exists.

### Bounds

Extension storage and published views are deliberately bounded. The extension
keeps a bounded number of Missions and update entries and publishes compact previews.
The full Mission is available through the owner tool, not copied into every
client snapshot. If real use outgrows extension private storage, add a generic
extension-resource store rather than a Mission-specific database.

## 5. State semantics

- `active`: work can proceed now.
- `waiting`: no action is useful until an external condition or future review.
- `needs_human`: a concrete decision or authority is required.
- `review`: the agent believes the success criteria may be satisfied.
- `paused`: work is intentionally suspended.
- `completed`: a human accepted the outcome.
- `cancelled`: a human ended the Mission without completion.

An agent may move a Mission among `active`, `waiting`, `needs_human`, `review`,
and `paused`. Only a human may mark it completed or cancel it. Ending an agent
turn has no effect on Mission status.

The optional deadline is a user constraint, not a default lifespan. A Mission
without a deadline remains active until a human completes, pauses, or cancels
it. Worker, cost, time, or concurrency limits belong on the Automations and
agent tasks that consume resources; they are optional policies, not Mission
identity.

## 6. Agent interface

The extension exposes three conceptual tools.

### `create-mission`

Starts a Mission from the current task and links that task with role `source`.
Required input is a title, brief, success criteria, and check-in cadence. A
deadline is optional. Creation also creates the primary review Automation and
queues its first run. The inline result confirms that work has started; it does
not ask the user to approve the same decision twice.

### `read-mission`

Returns one full Mission. An agent can supply an id or omit it when its calling
task is linked to exactly one current Mission. The tool returns structured
state and recent updates, not a synthesized coordinator prompt.

### `update-mission`

Performs one bounded mutation:

- append a comment, evidence item, question, or status update;
- link another existing native task;
- change a non-terminal status.

The daemon supplies the calling task identity. A tool caller may update only a
Mission already linked to that task. A linked agent can explicitly link another
existing task. Tasks created by a Mission-owned Automation are authorized using
daemon-observed provenance; possession of a Mission id is never sufficient
authority.

The injected Mission guidance should remain short:

1. Read the Mission before material work.
2. Use native Goals for bounded execution inside a task when helpful.
3. Post only meaningful changes, evidence, questions, or decisions.
4. Prefer an existing capable task; create another only for context isolation,
   a distinct harness, independent work, or independent review.
5. Put the Mission in `waiting` rather than spending tokens while nothing can
   change.
6. Put it in `needs_human` only with a concrete question.
7. Put it in `review` with evidence; never self-complete it.

## 7. Automation ownership

Missions uses one generic extension capability:

```text
automations:manage-owned
```

An owned Automation records an opaque owner reference:

```ts
type AutomationOwner = {
  extensionId: string;
  resourceId: string;
};
```

The existing control service remains authoritative. The extension receives a
reduced owner-only projection and can create, update, pause, resume, run now,
or delete only Automations whose `extensionId` matches itself. Normal
Automation validation, elevated-authority settings, revision checks,
run history, scheduler behaviour, and provider dispatch remain authoritative.
Create and run-now requests carry idempotency keys, while revision-bearing
updates use the same compare-and-swap rules as standalone Automations.

The owner reference is the relationship. A Mission does not persist redundant
Automation ids. Queries use `(extensionId, resourceId)`.

When a Mission becomes paused, completed, or cancelled, the host pauses its
enabled owned Automations. It does not interrupt a currently running native
task. Reactivation or a human decision can resume them explicitly.

### Primary review Automation

Starting a Mission creates one primary review Automation. Its settings should
be conservative and visible:

- managed reusable task;
- no arbitrary Mission deadline;
- a review cadence chosen from the brief or by the human before creation;
- provider/model left at user or Automation defaults unless specified;
- inherited permission and sandbox settings made clear before starting;
- no default worker count or instruction to spawn agents; and
- `run_once` misfire so a sleeping local daemon performs one useful review on
  return rather than replaying every missed interval.

The review prompt contains the Mission id and tells the agent to call
`read-mission`. The brief itself remains in the Mission record, so fresh tasks
do not depend on prompt-history compaction.

## 8. Human interaction and UI

The Missions page is a durable attention surface, not a runtime dashboard.

### List

Sort first by attention:

1. `needs_human`;
2. overdue active/review work;
3. `review`;
4. recently updated active/waiting work;
5. paused and closed work.

Each row/card shows title, status, optional deadline, latest meaningful update,
linked-task count, and next owned Automation run. Do not show
aggregate stat cards unless user testing proves they improve navigation.

### Detail

The first detail surface contains:

- brief and success criteria;
- status and optional deadline;
- `Message Mission`, which appends a human update and, when requested, runs the
  primary owned Automation now;
- recent chronological updates;
- linked native tasks with provider and status;
- owned Automations with next run and latest outcome; and
- pause, reactivate, complete, and cancel controls.

Clicking a linked task opens the normal provider-owned conversation. FalconDeck
does not copy transcripts into Mission storage.

The Scheduled page groups owned Automations under `Used by Missions`, while
standalone Automations remain separate. Every owned row opens the owning
extension's Mission surface. This prevents long-horizon check-ins from
overwhelming the ordinary schedule list.

## 9. Choosing tasks, harnesses, and models

There is no mandatory central coordinator task. Each review asks what execution
shape is cheapest and most reliable now.

Prefer reuse when a linked task has relevant context, is healthy, and has not
become confused or excessively compacted. Prefer a fresh task when clean
context is valuable, the old task is blocked, a different harness has a useful
capability, or independent verification is required.

The first version does not implement an LLM model router or automatic team
builder. The reviewing agent may recommend a provider or ask the human for a
material choice. Automation configuration records the actual decision. This is
more legible and cheaper than a hidden heuristic that continually creates
tasks.

Multi-agent work is justified for independent parallel work, specialized
capabilities, or independent review. It is not a progress metric. Agents should
not spawn more tasks merely because slots are available.

## 10. Reliability and safety

- Mission state and Automation state are durable before external dispatch.
- A provider operation with an unknown result is never blindly retried.
- Human denial, revoked authority, safety boundaries, and material ambiguity
  are not blockers to route around.
- Recovery means one materially different safe approach inside existing
  authority, followed by a concrete human question if necessary.
- Agent updates are claims with actor and task provenance. Deterministic host
  facts and Automation run outcomes remain distinguishable.
- Completion is criterion-led and human accepted.
- No agent loop runs while a Mission is merely waiting.
- If the owning daemon is offline, local reviews do not run. A remote always-on
  daemon is required for continuous unattended execution.

## 11. Implementation boundary

Missions is an extension-owned record and tool/UI layer over existing native
tasks and Automations. FalconDeck does not maintain a Mission coordinator,
worker pool, execution lease, automatic-turn counter, or separate run journal.
Deleting or disabling Missions therefore removes no hidden agent runtime.

The implemented surface is:

- durable Mission brief, status, criteria, updates, and task links;
- task-bound create/read/update tools;
- human guidance, pause, reactivation, completion, and cancellation;
- owner-scoped Automation create, update, pause, resume, delete, and run-now;
- daemon-observed provenance for Automation-created review tasks;
- Mission-owned Automation state on Mission and Scheduled surfaces; and
- `Message Mission` with optional immediate review.

The Mission does not become a long-running agent process. The Mission record
can remain active for months while its Automation sleeps. At each due check-in,
the existing scheduler starts or reuses an ordinary native task with a compact
review prompt and verified Mission provenance. That task reads the current
brief and updates, performs only the useful work available at that moment, and
posts evidence, a decision, or a concrete human question back to the Mission.

Creation copies execution settings from the Mission's source task, queues the
first run immediately, uses `queue_one` concurrency and `run_once` misfire
handling, and exposes pause, resume, run-now, next-run, and latest-outcome
state. If creating the Automation fails after the Mission record is saved, the
Mission card says that no agent has started and offers one recovery action:
`Start agent now`. Pausing or closing a Mission pauses future owned reviews but
does not interrupt a task already running.

## 12. Explicitly deferred

- virtual work items or Kanban;
- automatic model scoring/router;
- automatic team construction;
- agent-to-agent message bus;
- transcript storage;
- token or cost accounting without authoritative provider data;
- Mission-specific scheduler or always-running coordinator; and
- automatic completion by an LLM judge.

## 13. Acceptance criteria

1. Any eligible ordinary task can start a Mission through the declared
   extension tool, which queues the first check-in immediately.
2. The task is linked as the source and can read/update only that Mission.
3. A human can guide, pause, reactivate, complete, and cancel the Mission from
   the Missions UI.
4. Agents can add evidence/questions/status and link verified existing tasks.
5. The dashboard remains useful with no agent task running.
6. Mission work uses ordinary tasks and the existing Automation scheduler.
7. A malformed or oversized update fails visibly without corrupting stored
   Mission state.
8. Focused extension-host, fake-host, client-core, and desktop tests pass.
9. Only the owning extension can manage an owned Automation.
10. Mission-owned Automations use the existing scheduler and appear grouped in
    both Mission and Scheduled UI.
11. A task produced by an owned Automation can read/update its Mission through
    daemon-observed provenance.
12. Pausing or closing a Mission prevents future owned Automation runs.
13. Restart, misfire, revision, elevated-authority, and unknown-outcome semantics
    remain those of Agent Control rather than a Mission-specific copy.
