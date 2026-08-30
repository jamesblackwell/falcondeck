# Missions: critique and improved implementation specification

Status: bounded coordinator plus serial Codex-worker slice implemented on 2026-08-30. Richer team
planning, parallel read-only workers, worker follow-ups, and the later phases remain proposals.

`docs/EXTENSIONS.md` remains the canonical extension contract. The v1 generic identity, permission,
run/effect, receipt, panel-action, and lifecycle changes are now reflected there and in the public
schemas. Sensitive orchestration calls use an opaque, daemon-issued bridge capability. Claude binds
it directly to the task selected at provider spawn. For Codex, the daemon binds a workspace-wide
bridge only when exactly one Codex task in that workspace is running and rejects ambiguous calls.
OpenCode coordinators remain ineligible.

This document replaces the earlier idea of implementing Missions as an indefinitely continuing
coordinator prompt with a few thread tools. It keeps the useful product idea—an ordinary FalconDeck
task can coordinate bounded work across harnesses—but moves identity, authority, limits, dispatch,
and recovery outside the model.

## 1. Decision summary

A Mission is a **durable, bounded automatic-execution lease attached to an ordinary coordinator
task**. User-initiated turns remain outside that automatic envelope and may cause reconciliation.

- Missions remain a bundled, disabled-by-default official extension rather than a core FalconDeck
  product mode.
- Harness-native goals are optional. A Mission can supervise ordinary threads and turns on a
  harness that has no goal feature at all.
- The first slice proved one existing coordinator task, secure continuation, deadlines, restart
  recovery, human races, and completion. The current slice adds at most three serial, one-turn Codex
  workers without adding worker-to-worker messaging or native delegation.
- The human continues talking in the coordinator task. FalconDeck does not add a conversation
  database or replace harness-owned history.
- A coordinator turn is finite and may end normally. The Mission persists while every task is idle,
  and wakes the coordinator only after a meaningful durable state change.
- The model proposes plans, follow-ups, obstacles, evidence, and completion. The daemon owns caller
  identity, permissions, hard limits, dispatch, reconciliation, and terminal transitions.
- The first multi-task version has one coordinator and a fixed, human-approved pool of at most three
  FalconDeck-managed workers. Native harness delegation must be mechanically disabled for automatic
  team turns. There is no worker-to-worker messaging or autonomous expansion of the managed team.
- Completion requires criterion-level evidence and human acceptance in the first release. An LLM
  reviewer is advisory, not an oracle.

The key correction is:

> A prompt and a few tools are enough for the conversational surface, but not for the reliability
> claim. The smallest dependable feature is a fallible coordinator inside a small deterministic,
> daemon-enforced run envelope.

## 2. What was right in the original direction

The earlier design identified several important product truths:

1. FalconDeck can become an orchestration layer without forcing every harness to implement the same
   native goal abstraction.
2. A normal conversation is the right place to discover, discuss, and steer a Mission.
3. Cross-harness workers can be useful for genuinely independent research, review, or implementation
   work.
4. Hard caps on worker count, elapsed time, and automatic work are necessary.
5. This belongs in an extension so FalconDeck can prove a reusable orchestration capability without
   turning the whole product into one opinionated agent loop.

Those conclusions still stand. The problem is that the proposed coordinator had too much authority
and the host runtime had too little durability.

## 3. Main critique

### 3.1 “Cannot end” is the wrong invariant

An agent turn that must keep going until it declares success or a hard block encourages status
narration, repeated planning, duplicate delegation, and increasingly inventive attempts to evade a
stopping condition. It also spends tokens while nothing has changed.

The useful invariant is narrower:

> A Mission cannot become complete merely because a turn ended or an agent said it was done.

Turns end freely. Mission state remains non-terminal until evidence and an authoritative transition
say otherwise. FalconDeck waits without an LLM running and starts another coordinator turn only when
there is a decision to make.

### 3.2 “Work around blocks” can become unsafe persistence

A coordinator told to be unusually hard to stop can interpret a permission denial, policy boundary,
ambiguous user intent, or exhausted budget as an obstacle to route around. Recovery must therefore be
typed and bounded.

FalconDeck may automatically recover from a transient provider or technical failure inside existing
authority. It must never work around:

- a user denial;
- a revoked permission;
- a sandbox or safety boundary;
- missing authority;
- material ambiguity in the requested outcome;
- an exhausted hard limit; or
- an unresolved write-ownership conflict.

Persistence should mean “try one materially different safe approach,” not “be stubborn.”

### 3.3 The pre-Missions public extension API could not perform the job

An extension callback receives daemon-supplied state, handles one action/tool/event, and returns
updated storage, views, a result, and at most one bounded orchestration effect. It still cannot call
raw thread control, start or interrupt a turn directly, or hold a long-running callback. The daemon
persists and executes the accepted effect outside the host callback. The Deno host exposes no raw
daemon/network facet through the SDK and is launched without ordinary write/network grants. The
daemon remains the complete permission boundary; host sandbox hardening is defence in depth.

This remains a reducer runtime, now paired with a small durable daemon broker. Directly making
long-running daemon calls from an extension callback would still serialize that extension's host and
exceed its five- or ten-second callback limits.

### 3.4 Caller identity has to be eligibility-gated by harness

Mission tools need to know, without trusting the model, which workspace and task made a call. The
bridge now transports an opaque daemon-issued capability in its private environment and the daemon
resolves sensitive effects from that capability rather than request-body identifiers. Harness shape
still limits where this can be issued safely:

- Codex and native OpenCode use workspace-wide runtimes and currently install the extension bridge
  without a fixed thread ID.
- Claude's per-turn subprocess receives a real thread ID and a task-bound capability.
- The loopback API remains localhost-only; untrusted or expired capabilities receive no orchestration
  projection and cannot authorize a coordinator effect.

Consequently FalconDeck enforces “only this coordinator may checkpoint this run” for Claude v1 and
rejects Codex/OpenCode adoption. Model-supplied IDs remain unacceptable substitutes.

There is also a tool-availability problem. Enabling or granting an extension after a workspace-wide
Codex or OpenCode process has started does not necessarily hot-add its tools to that process. The
product promise must therefore be **any eligible task**, not literally any historical task.

### 3.5 Extension events are wake-up hints, not a mission log

Extension lifecycle queues are in-memory, bounded to 256 events, drop events under pressure, and are
cleared on shutdown. The public `turn.ended` projection intentionally omits outcome/error detail.
Claude now receives a daemon turn receipt with start/end events, but events remain refresh hints, not
the durable run journal.

Missions cannot derive truth from receiving every event once. Events may mark a Mission dirty and
wake reconciliation; progression must use authoritative persisted run, operation, and task state.

### 3.6 There is no durable external-operation boundary

Thread creation and turn start do not currently accept a durable orchestration operation ID. A
harness may accept a thread or prompt just before FalconDeck crashes, while FalconDeck fails to save
the acknowledgement. Blind retry can then create duplicate tasks, duplicate prompts, or two writers
in the same checkout.

FalconDeck cannot promise exactly-once execution in arbitrary harnesses. It can promise that:

- accepted Mission state transitions are durably recorded once;
- each external intent has a stable ID and immutable full-envelope hash;
- retries occur only when the destination can deduplicate or FalconDeck can reconcile; and
- ambiguous acceptance becomes `outcome_unknown`, never a blind resend.

### 3.7 Current thread APIs have foreground side effects

Ordinary thread creation and turn dispatch can change the workspace's current task and default
provider. Background Mission work must not steal selection or silently change the user's default
harness. Mission-created tasks also need provenance recorded atomically, rather than patched onto a
thread after creation.

### 3.8 Current permission defaults are unsuitable for unattended work

When settings are omitted, FalconDeck's current local-testing defaults inject highly permissive modes
such as Codex `danger-full-access`/`never`, Claude `bypassPermissions`, or OpenCode `always-approve`.
A Mission must require an explicit, user-visible safety profile for every managed task. It must never
inherit a testing default and call it an approved autonomous envelope.

### 3.9 The coordinator cannot verify itself

The same model that planned and performed work is biased toward accepting it. A second model may
catch issues, but agreement between two agents is still a claim, especially when both rely on the
same transcript or poisoned source material.

Mission state must distinguish:

- daemon-observed facts;
- captured external evidence;
- worker-reported claims;
- coordinator interpretations; and
- missing evidence.

In the first release, only the human accepts completion. Deterministic checks can later authorize
opt-in automatic completion for narrowly defined criteria.

### 3.10 More agents are not automatically better

Multi-agent work helps when assignments are independent and parallelizable. It hurts tightly coupled
or sequential work by multiplying communication, context, conflicting edits, and repeated mistakes.
The Mission coordinator should not be rewarded for using every worker slot.

The default Mission starts with zero workers. A worker is justified only by an independent assignment,
a distinct capability, or a deliberate independent review. One coordinator plus a small star topology
is the useful shape; an expanding society of agents is not.

### 3.11 Hard limits can only cover work FalconDeck controls

FalconDeck can enforce limits on FalconDeck-managed task creation and automatic turn starts. It cannot
truthfully count invisible harness-native subagents, arbitrary child processes, or every provider
token unless the harness exposes authoritative attributable usage.

The UI must say “managed workers” and “automatic Mission turns.” Token and cost estimates remain soft
telemetry until every supported harness provides dependable accounting.

### 3.12 Worker reports are untrusted input

A worker can relay prompt injection from a repository, web page, issue, or tool result. Reports must
be bounded, typed, provenance-labelled data, never privileged instructions interpolated into the
coordinator charter. Whatever a report says, all resulting effects still pass daemon permissions,
revision checks, and the Mission envelope.

### 3.13 Code-audit anchors

The main implementation findings above are grounded in these current paths (line anchors are a
2026-08-30 snapshot):

| Finding | Current source |
| --- | --- |
| Extension callbacks persist storage/views and return a synchronous result, but have no durable external-operation intents | [`apps/extension-host/main.ts`](../apps/extension-host/main.ts#L299), [`extensions.rs`](../crates/falcondeck-daemon/src/app/extensions.rs#L694) |
| Extension host callbacks are time-bounded; sandbox flags are defence in depth, not authority | [`extension_host.rs`](../crates/falcondeck-daemon/src/app/extension_host.rs#L21), [`extension_host.rs`](../crates/falcondeck-daemon/src/app/extension_host.rs#L441) |
| Turn-control permissions remain planned | [`EXTENSIONS.md`](EXTENSIONS.md#10-permissions-and-trust) |
| Codex/OpenCode install the workspace bridge without thread context | [`codex.rs`](../crates/falcondeck-daemon/src/codex.rs#L535), [`opencode_threads.rs`](../crates/falcondeck-daemon/src/app/opencode_threads.rs#L110) |
| Claude can bind a connector per turn | [`provider_runtime.rs`](../crates/falcondeck-daemon/src/app/provider_runtime.rs#L398) |
| Extension lifecycle queues are bounded and lossy | [`extension_events.rs`](../crates/falcondeck-daemon/src/app/extension_events.rs#L14) |
| Thread creation and turn dispatch lack orchestration operation IDs | [`falcondeck-core/src/lib.rs`](../crates/falcondeck-core/src/lib.rs#L1929), [`falcondeck-core/src/lib.rs`](../crates/falcondeck-core/src/lib.rs#L2748) |
| Foreground start/send paths have workspace-selection side effects | [`workspace_ops.rs`](../crates/falcondeck-daemon/src/app/workspace_ops.rs#L1109), [`workspace_ops.rs`](../crates/falcondeck-daemon/src/app/workspace_ops.rs#L2694) |
| Omitted provider settings can select permissive defaults | [`workspace_ops.rs`](../crates/falcondeck-daemon/src/app/workspace_ops.rs#L918) |
| Agent Control already demonstrates daemon-owned persistence and scheduling | [`AGENT-CONTROL.md`](AGENT-CONTROL.md) |

## 4. Research and reference implementations

The prior art supports the corrected design but none of it should be adopted wholesale.

| Reference | Verdict | Useful lesson | Important warning |
| --- | --- | --- | --- |
| [ByBrawe/opencode-goal](https://github.com/ByBrawe/opencode-goal/tree/75408cd6cefedd39466a7535defa2d478ae92a38) | **Strongest OpenCode study reference** | Goal contracts, CAS/revision isolation, host checks, leases, restart recovery, optional budgets, and fail-closed completion | It owns one OpenCode/project runtime and can run checks directly; its README claims need source-level validation before reuse |
| [mirsella/opencode-goal](https://github.com/mirsella/opencode-goal/tree/7feb55d8a863d3878fa09d176418a89dffcdd949) | **Study minimal UX** | Small same-session goal, persisted state, idle continuation, and `update_goal` tool | Experimental; no hard token/turn budget or terminal recovery cap |
| [Temporal](https://github.com/temporalio/temporal/tree/c044bf16b1cc47a4db80669a987484dba6145331) | **Study semantics** | Durable state, timers, operation history, cancellation states, and reconciliation | A full Temporal deployment and deterministic workflow runtime would be disproportionate |
| [LangGraph](https://github.com/langchain-ai/langgraph/tree/11ee185999b86bfea2d8c0e69cef9a5e37acf686) | **Study semantics** | Checkpoints, pending writes, bounded supersteps, and durable human interrupts | It owns every workflow node; FalconDeck supervises opaque harnesses and cannot inherit those guarantees |
| [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk/tree/9d143aac35c2dcec9cbb046ff9f35ac5eb072f6a) and [Automation](https://github.com/OpenHands/automation/tree/a6ebc7d4f70bba1baf210e145fd21749341f458e) | **Study selectively** | Completion-audit UX plus persisted automation and run history | The goal loop is conversation-local and an LLM judge is weak authority; Automation is beta and a different product |
| [Magentic-One](https://github.com/microsoft/autogen/tree/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one) | **Study pattern** | Fixed star topology, task/progress ledgers, and explicit stall counts | The coordinator still self-certifies completion and message-round limits are not a durable Mission envelope |
| [CrewAI Flows](https://github.com/crewAIInc/crewAI/tree/da4daadba0e5049abc00fee8bc31b8b8019c60dd) | **Avoid as authority** | Explicit routing, typed state, and approachable workflow ergonomics | Latest-state snapshots, best-effort checkpoints, and in-process events are not durable cross-harness dispatch |

The linked implementation repositories are permissively licensed (MIT for the reviewed source
trees). Temporal, LangGraph, OpenHands, CrewAI, and the ByBrawe OpenCode project were active at the
review date. The smaller mirsella plugin is intentionally minimal. AutoGen's
[reviewed README](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/README.md)
directs new users toward Microsoft's successor Agent Framework. These are references to study, not
dependencies to import.

The minimal OpenCode reference is especially instructive. Its [core implementation](https://raw.githubusercontent.com/mirsella/opencode-goal/7feb55d8a863d3878fa09d176418a89dffcdd949/src/index.ts)
persists per-session goal state with a temporary-file replacement, listens to `session.status`,
applies a 750 ms debounce between continuation starts, and injects a synthetic prompt. After two stop-only
continuations it changes its prompt into a recovery mode, but it keeps going and has no hard total
turn/token budget. That is an effective prototype of the user experience and a caution against using
“idle means prompt again” as the runtime.

The more developed [ByBrawe implementation](https://github.com/ByBrawe/opencode-goal/tree/75408cd6cefedd39466a7535defa2d478ae92a38)
is closer to the desired reliability shape: its documented contract includes current-revision host
evidence, atomic/CAS state, per-session ownership, process leases, restart recovery, explicit
turn/token/time/cost limits, and a fail-closed audit pipeline. It also exposes the limits of direct
reuse: it is OpenCode/project-specific, shell/file verification runs inside that plugin's authority,
separate sessions can still conflict in one workspace, and its cumulative token cap defaults to
unlimited unless configured. Treat those documented mechanisms as strong patterns to source-audit,
not as inherited guarantees for a cross-harness FalconDeck layer.

Other relevant evidence:

- [METR's time-horizon work](https://metr.org/time-horizons/) defines a horizon as the human-equivalent
  difficulty completed at a chosen reliability, not how long an agent may run. A two-hour Mission
  deadline is a spending envelope, not evidence of two-hour task capability.
- [Anthropic's long-running-agent guidance](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
  recommends structured progress, checkpoints, tests, and fresh contexts rather than relying on
  transcript continuity alone.
- [Anthropic's multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system)
  reports large token multiplication and says multi-agent designs work best for breadth-first,
  parallelizable tasks. Its early systems spawned excessive workers and searched indefinitely.
- A recent controlled [study of 180 agent-system configurations](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)
  found centralized coordination useful for parallel work but substantial degradation on sequential
  tasks. This is recent research and should be treated as suggestive rather than settled.
- [Anthropic's parallel compiler experiment](https://www.anthropic.com/engineering/building-c-compiler)
  demonstrates merge conflicts, duplicated work, one shared bottleneck, and very high cost even in a
  successful multi-agent project.
- [AgentDojo](https://proceedings.nips.cc/paper_files/paper/2024/hash/97091a5177d8dc64b1da8bf3e1f6fb54-Abstract-Datasets_and_Benchmarks_Track.html)
  demonstrates that tool results can carry indirect prompt injection into an agent.
- OpenAI's official [Follow a goal](https://learn.chatgpt.com/use-cases/follow-goals) UX is a useful
  native reference for one durable objective, explicit stopping conditions, and checkpoints. It stops
  when Codex is confident; that is a product convenience, not an independent completion oracle.

Confidence is high in the architectural conclusions and current FalconDeck blockers. Confidence is
medium in provider-specific hot-tool paths because Codex dynamic tools and several third-party agent
APIs remain experimental and change quickly.

## 5. Product definition

### 5.1 Mission

A Mission is a revisioned objective, acceptance contract, evidence map, and bounded automatic-work
lease attached to one coordinator task. V2 may add a fixed approved job plan.

It is not:

- an immortal model turn;
- a replacement for harness-native sessions or history;
- a promise that every supported harness implements goals;
- a generic peer-to-peer agent network;
- a way to bypass native harness approvals; or
- an assertion that FalconDeck controls native subagents or all spend.

### 5.2 Ownership boundaries

```mermaid
flowchart LR
    H[Human] -->|chat and steering| C[Coordinator task]
    H -->|Start / Pause / Cancel / Extend / Accept| U[Mission panel]
    C -->|typed proposals| E[Missions extension reducer]
    W[Worker tasks] -->|typed reports| E
    U -->|declared extension actions| E
    E -->|revisioned checkpoint and intents| B[Daemon orchestration broker]
    B -->|bounded background operations| A[Harness adapters]
    A --> C
    A --> W

    C -. transcript owned by .-> X[Underlying harness]
    W -. transcripts owned by .-> X
```

- **Harness:** owns the coordinator/worker sessions, transcripts, tool execution, and files.
- **Missions extension:** owns mission policy, coordinator charter, objective, criteria, job plan,
  reports, evidence mapping, and UI projections.
- **Daemon orchestration broker:** owns trusted identity, a run lease, hard limits, operation
  admission, durable dispatch state, deadlines, reconciliation, pause, and cancellation.
- **Human:** owns activation, material contract/criteria changes, permission expansion, limit increases,
  and final completion acceptance.

This preserves the rule that extensions do not replace core data ownership. The daemon substrate is
mission-agnostic and exposes a public SDK facet; the official Missions extension uses only that public
facet.

## 6. Minimal daemon orchestration broker

Do not add Temporal, LangGraph, or another agent framework. Reuse Agent Control's daemon-owned
persistence, revision, idempotency, scheduling, and misfire-recovery patterns. Harness admission,
operation receipts, and ambiguous-outcome reconciliation are new work; Agent Control does not already
solve those parts.

The broker is deliberately mission-agnostic. It knows about an extension-owned run, an anchor task,
approved operation slots, owned entities, a deadline, and external operations. It does not know what
a coordinator, worker, job, follow-up, recovery round, or acceptance criterion is.

The broker needs only three fundamental capabilities:

1. daemon-authenticated per-invocation identity;
2. a durable, bounded, idempotent operation journal; and
3. provider-independent receipts plus startup reconciliation.

### 6.1 Generic run record

```ts
type SourceTurnWatch = {
  id: string;
  threadId: string;
  interactionRevision: number;
  providerTurnId?: string;
  status:
    | "pending"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "outcome_unknown"
    | "abandoned"
    | "superseded";
  errorCategory?: string;
  receiptRef?: string;
};

type ExtensionRun = {
  id: string;
  ownerExtensionId: string;
  workspaceId: string;
  anchorThreadId: string;

  gate: "active" | "paused" | "cancel_requested" | "draining" | "closed";
  outcome?: "completed" | "cancelled" | "closed_incomplete";
  pauseReason?: string;

  // CAS for checkpoint, authority, limits, and control changes.
  policyRevision: number;

  // Daemon-assigned ordering for operation/status/receipt changes.
  journalSequence: number;

  // Advances whenever the human-approved contract/authority changes.
  approvalGeneration: number;
  automaticDispatchDeadlineAt: string;

  admissionSlots: Array<{
    id: string;
    kind: "turn.start_if_idle" | "thread.create" | "turn.interrupt";
    target: RunTarget;
    maxAdmissionsTotal: number;
    executionProfile: ProviderExecutionProfile;
  }>;

  usage: {
    admissionsReservedBySlot: Record<string, number>;
    admissionsTotalBySlot: Record<string, number>;
    operationsInFlight: number;
    operationsUnresolved: number;
  };

  maxOperationsInFlight: number;
  maxOperationsUnresolved: number;
  ownedEntityIds: string[];
  sourceTurnWatches: SourceTurnWatch[];
  dirty: boolean;

  // Bounded, schema-versioned, opaque to the generic broker.
  extensionCheckpoint: unknown;
  schemaVersion: number;
  ownerImplementationVersion: string;
};
```

Release v1 creates exactly one admission slot: up to four `turn.start_if_idle` operations targeting
the anchor task, with one in-flight and one unresolved operation. It has no background task creation,
worker quota, interrupt operation, write lease, or job model. Those slots are added only by the v2
team design.

V1 also permits one pending `SourceTurnWatch`. It is not an operation or an admission: it lets the
broker durably observe settlement of the human-authored or automatic turn that recorded a
continuation/completion proposal. Registering the watch and its checkpoint request is one atomic
mutation.

An admission slot contains the exact generic constraints the daemon must enforce: operation kind,
target, maximum admissions, and adapter-supported provider/model/sandbox/approval/network/write
profile. The opaque extension checkpoint cannot broaden them. It is not enough for core to see only a
provider name and a fictional cross-provider `read_only` flag.

A read-only team worker is eligible only when the harness can mechanically enforce the approved
profile. Claude/OpenCode must not be treated as equivalent to Codex's filesystem read-only sandbox
until their adapters provide an enforceable mapping.

Hard invariants:

- `policyRevision` is the only caller-supplied compare-and-swap revision. It changes for checkpoint,
  approved authority/limit, human/extension control, and broker-enforced gate mutations;
- `journalSequence` orders every operation/status/receipt/usage mutation but is never used to
  overwrite extension policy. Normal journal movement does not make an otherwise valid agent tool
  mutation stale;
- `approvalGeneration` changes only when approved authority changes and is copied onto every intent;
- cumulative admission totals survive restart and are never refunded after ambiguous acceptance;
- live `operationsInFlight` and `operationsUnresolved` gauges decrement only on their defined terminal
  or reconciled transitions;
- a definitive terminal status, its final receipt or explicit unavailable marker, counter changes,
  and dirty marking commit atomically before capacity is released;
- capacity is reserved atomically before provider admission;
- only a daemon-authenticated `human_ui` action may increase a slot, widen its execution profile, or
  close the run with outcome `completed`;
- only an explicitly confirmed `human_ui` recovery action may mark `outcome_unknown` as `abandoned`,
  after which the run can end only as `closed_incomplete` and conflicting resources remain
  quarantined;
- a material contract change advances `approvalGeneration` and rejects queued older-generation
  operations;
- older-generation operations may append immutable receipts, but cannot schedule new effects or
  mutate current policy automatically;
- `dispatching → outcome_unknown` atomically pauses the run with `pauseReason: outcome_unknown`;
- no run may close with any in-flight/unresolved operation or pending/unknown source-turn watch; the
  warned abandon command first makes them terminal and quarantines their resources;
- all extension mutations carry the expected policy revision and approval generation, while their
  requested effects are revalidated against current journal capacity in the commit transaction; and
- deadline or gate checks occur in the same serialized admission step as operation reservation.

The automatic dispatch deadline is not the deletion time. When it expires, no new automatic work may
start. The run remains reviewable and the human may extend, resume, complete, cancel, or close it
incomplete.

For the bounded first release, this can use one versioned daemon-owned persistence unit under a
serialized service lock. The API semantics should not depend on whether a later implementation moves
the journal to SQLite.

`extensionCheckpoint` is namespaced owner-only state exposed through the public orchestration facet,
not a second ad hoc core Mission record. Give it explicit per-run and per-extension byte bounds,
schema-versioned migration, and the same no-secret rule as ordinary extension state. On an
incompatible upgrade, pause the run read-only. Disabling the extension pauses open runs. Uninstall or
data deletion must be blocked while runs are open unless the human first cancels/closes or exports
them; it must never silently orphan daemon-owned operations.

### 6.2 Operation journal

```ts
type BoundedOperationPayload = {
  schemaVersion: 1;
  target: RunTarget;
  expectedInteractionRevision?: number;
  prompt:
    | { kind: "inline"; text: string }
    | { kind: "daemon_blob"; ref: string; sha256: string; byteLength: number };
  executionProfile: ProviderExecutionProfile;
  providerIndependentOptions: Record<string, boolean | number | string>;
};

type OrchestrationOperation = {
  id: string;
  runId: string;
  approvalGeneration: number;
  admissionSlotId: string;

  // Immutable replay material. intentHash covers the canonical full intent envelope.
  payload: BoundedOperationPayload;
  intentHash: string;

  kind: "turn.start_if_idle" | "thread.create" | "turn.interrupt";
  status:
    | "queued"
    | "dispatching"
    | "acknowledged"
    | "settled"
    | "outcome_unknown"
    | "rejected"
    | "cancelled"
    | "abandoned";

  providerThreadId?: string;
  providerTurnId?: string;
  receipt?:
    | BoundedOperationReceipt
    | { status: "unavailable"; reason: string; observedAt: string };
};

type OrchestrationOperationIntent = Pick<
  OrchestrationOperation,
  "id" | "approvalGeneration" | "admissionSlotId" | "kind" | "payload" | "intentHash"
>;
```

Only `turn.start_if_idle` exists in v1. The other kinds are reserved for v2 and do not need to be
implemented early.

An extension reduction commits its new checkpoint and operation intents in one daemon transaction.
The extension callback then returns immediately; it never waits for a harness. `intentHash` covers the
canonical tuple of run ID, approval generation, admission slot, operation kind, and bounded payload.
Reusing an operation ID with any different envelope field fails. A crash during provider admission
becomes `outcome_unknown` unless the adapter can correlate and reconcile the original request.

The journal must retain the exact immutable dispatch material, not merely its hash. Inline payloads
have a strict byte cap; a larger prompt uses a daemon-owned content-addressed blob with the same
retention and deletion rules as its run. The adapter derives provider-specific request syntax only
from this payload plus the immutable admission slot. Secrets and ambient defaults are forbidden.
After restart, a queued operation can therefore be dispatched identically, and an ambiguous operation
can be correlated without reconstructing a prompt from mutable Mission state.

Operation accounting is normative:

| Status | Admission accounting | In flight | Unresolved | Allowed next status |
| --- | --- | ---: | ---: | --- |
| `queued` | one temporary slot reservation | 0 | 1 | `dispatching`, `rejected`, `cancelled` |
| `dispatching` | reservation converts once to permanent admission total before the provider call | 1 | 1 | `acknowledged`, `rejected`, `outcome_unknown` |
| `acknowledged` | permanent total retained | 1 | 1 | `settled`, `cancelled`, `outcome_unknown` |
| `outcome_unknown` | permanent total retained | 0 | 1 | a reconciled definitive status, or human `abandoned` |
| `settled` | permanent total retained | 0 | 0 | terminal |
| `rejected` | refunded only if it never left `queued`; otherwise permanent total retained | 0 | 0 | terminal |
| `cancelled` | refunded only if it never left `queued`; otherwise permanent total retained | 0 | 0 | terminal |
| `abandoned` | permanent total retained; explicit unconfirmed-work audit record | 0 | 0 | terminal |

`operationsInFlight` counts `dispatching` and `acknowledged`; `operationsUnresolved` counts every
non-terminal status, including `queued` and `outcome_unknown`. A cancellation request against accepted
work does not produce `cancelled` until the adapter confirms it. The queued reservation and permanent
total conversion are serialized with status changes, so restart or duplicate reduction cannot count
an operation twice.

Every definitive terminal transition atomically writes the final bounded receipt—or a typed
`unavailable` marker when the adapter cannot supply one—updates counters, and marks the run dirty.
Only that commit releases capacity. An adapter must process the provider's final event before making
the transition; later supplemental telemetry may append a separate immutable journal fact, but cannot
retroactively masquerade as evidence that authorized a successor.

`abandoned` is an exceptional human recovery transition, never an automatic reconciliation result.
It is available only after the gate is paused, bounded reconciliation and stop attempts have failed,
and the UI explicitly warns that external work may still exist. It permanently records the unknown
provider/task identifiers, permits only `closed_incomplete` (not completed), and never authorizes a
replacement writer. This avoids making an unrecoverable provider record also make the extension
impossible to uninstall, without falsely claiming the external work stopped.

The host-owned `abandon_and_close_incomplete` command atomically marks the selected unknown operations
or source-turn watches abandoned, closes the run incomplete, and creates daemon-owned quarantine
tombstones for their target resources/execution profiles. Tombstones survive extension uninstall and
reject conflicting future automatic work. They clear only when later authoritative reconciliation
proves termination or a human confirms an external stop through a separately warned host action.
Human-authored task interaction remains possible; the quarantine is a guard against silently
replacing potentially live autonomous work.

`turn.start_if_idle` uses a daemon-owned monotonic `interactionRevision`, advanced when a human or
automatic turn/steer is admitted—not by unrelated metadata changes. Compare, reserve, and admit occur
under one per-thread serialization gate:

- a human request arriving before provider admission advances `interactionRevision` and cancels the queued
  automatic request;
- an automatic turn never silently queues behind a human turn;
- once the provider has accepted a turn it cannot be unsent, so the UI shows it as in flight rather
  than claiming the human won a completed admission race; and
- background admission does not change current-task selection or the default provider.

A coordinator normally calls `mission_checkpoint(continue_self)` from inside a running turn. If that
turn was automatic, it is represented by the current unresolved operation; if it was human-authored,
it is represented only by its authenticated provider turn and `interactionRevision`. In both cases
the tool call atomically persists a **continuation request** and registers a `SourceTurnWatch`. It
never reserves a successor while the current provider turn is still running. When that exact turn
settles, the dirty-run reducer releases live operation capacity when applicable and then, in one
serialized reduction, rechecks thread idleness, gate, deadline, interaction revision, admission
total, and progress fingerprint before it may commit one successor intent. This prevents both a deadlock at
`maxOperationsUnresolved = 1` and an accidental second continuation after a newer human message wins
the race.

The saved `PendingContinuation` carries a daemon-generated request ID, current approval generation,
authenticated source-turn identity, the activation's baseline progress fingerprint, and a stable
successor operation ID. `reconcileRun` may atomically change it from `pending` to `consumed` and insert
that exact successor once. A duplicate reduction sees the same consumed request/operation ID and does
nothing. A contract-generation change, superseding human interaction revision, failed source turn,
or closed gate changes it to `cancelled` instead of dispatching stale intent.

### 6.3 Receipts and reconciliation

The broker, not the lossy public extension queue, durably marks a run dirty whenever an owned
operation/task changes. A coalesced scheduler reconciles dirty runs independently. While an operation
is unresolved **or a source-turn watch is `pending` or `outcome_unknown`**, a bounded status timer
supplies eventual reconciliation if the provider emits no usable event. It resolves the exact
provider turn and interaction revision to a normalized success/failure/cancel/unknown outcome or
`superseded`, with a receipt reference when available, then atomically marks the run dirty. It never
infers success from mere thread idleness. A watched `outcome_unknown` pauses the gate like an unknown
operation and remains unresolved until reconciliation or explicit human abandonment. This is daemon
state polling, not an LLM heartbeat.

The public orchestration facet therefore adds one bounded owner callback:

```ts
reconcileRun({
  reason,
  runSummary,
  operations,
  ownedTaskStates,
  extensionCheckpoint,
  policyRevision,
  approvalGeneration,
  journalSequence,
}): {
  expectedPolicyRevision: number;
  expectedApprovalGeneration: number;
  observedJournalSequence: number;
  nextCheckpoint: unknown;
  intents: OrchestrationOperationIntent[]; // zero or one in v1
  acknowledgeSourceTurnWatchIds: string[]; // zero or one in v1
}
```

This is where the Missions extension—not the generic broker—computes its progress fingerprint,
consumes a pending continuation, admits completion review, or updates an obstacle. Calls are
serialized through the normal extension-host boundary and have its ordinary short timeout. The
response commits checkpoint and intents atomically only if policy revision, approval generation, and
the observed journal sequence still match. Acknowledging a terminal/superseded source watch removes
it from the active watch set in that same commit while retaining its outcome journal fact. Only a
`succeeded` source may authorize its pending continuation or completion review; failure,
cancellation, unknown outcome, or supersession cancels that proposal or leaves it reconciling.
Otherwise the response is discarded and invoked again with a fresh snapshot; no model turn is
repeated. On timeout, crash, or invalid output, no effect commits, the run stays dirty, and the daemon
retries with bounded backoff. Repeated callback failure pauses automatic
dispatch and leaves host-owned emergency controls available. V1 permits three consecutive callback
attempts for the dirty state (one initial call plus two retries) before pausing with
`extension_unhealthy`; a host-owned human Retry reconciliation action starts a fresh bounded series.

Before the extension decides anything, the broker supplies a fresh snapshot of operations and task
states. Each owned turn produces a bounded receipt where the harness supports it:

- normalized outcome and error category;
- provider thread/turn correlation IDs;
- bounded final-result text or a harness-owned reference;
- authoritative usage if available; and
- artifact/evidence references exposed by the provider.

This is not a transcript database. It is one compact operation result. If a provider cannot expose a
field, FalconDeck marks it unavailable rather than inferring it.

Expose receipts through a new owner-only, permission-gated orchestration-receipt facet with explicit
per-receipt/run size limits, redaction, bounded retention, pagination, revocation behavior, and
SDK/fake-host tests. It is not `threads:read` and grants no transcript access. V1 keeps its Mission
panel projection within the existing bounded view limits; v2 must not stuff team history into one
view blob.

On daemon restart, extension re-enable, provider reconnect, or a dirty run, reconciliation occurs
before dispatch. Unknown provider status renders `Reconciling`, not `Running`, `Failed`, or
`Complete`.

If a dispatch crosses into `outcome_unknown`, the broker closes the automatic-dispatch gate by
atomically pausing the run. No correction, retry, continuation, or new worker may start until the
original operation is reconciled to a defined terminal state and a human explicitly resumes. A later
provider result may append an immutable receipt, but it does not silently reopen the gate.

### 6.4 Controls and permission

Mission-specific Start, Resume, Extend, and Accept actions are declared extension actions. They commit
the checkpoint change and generic run mutation atomically. The generic broker does not decide whether
acceptance criteria are met.

The host also exposes generic emergency Pause and Cancel controls, plus Retry reconciliation and the
explicitly warned `abandon_and_close_incomplete` recovery when the owner is unhealthy. Pause/Cancel
close the dispatch gate first; after the extension recovers, it reconciles its checkpoint from the
authoritative run state.

That fallback requires a small host-readable `OwnedRunSummary` facet—run ID, owner extension, anchor
task, gate/outcome, pause reason, policy revision, journal sequence, deadline, aggregate admission
usage, current operation state, and quarantine warnings. Pause, Cancel, bounded reconciliation retry,
and abandon/close-incomplete are daemon-routed human commands against that generic record rather than
extension actions; Retry asks the broker to invoke `reconcileRun` again. The trusted panel shell can
therefore render a minimal crash view and retain safety controls even when the Mission bundle fails
to load. This is generic orchestration infrastructure, not a Mission-specific core record.

The public SDK permission ID is neutral, for example `orchestration:manage-owned-tasks`; the Missions
extension supplies the user-facing label “Manage bounded Mission tasks.” In v1 it permits only
adopting the eligible anchor task, starting bounded turns in that task, and reading its bounded status.
V2 separately adds owned background-task creation/control.

The activation action creates a run-specific lease; it does not grant arbitrary thread control.
Revocation or extension disable prevents new dispatch immediately and pauses the run. Underlying
harness tasks and history are not deleted.

Permission bootstrapping is host-owned. The Start action declares the orchestration permission it
requires. On the first click, the host confirms the grant, the daemon persists it, and only then does
the host invoke (or retry once) the same declared extension action with authenticated `human_ui`
actor metadata. If the user declines, no extension callback runs and no lease or run is created. The
extension can request neither the grant nor its own retry.

Re-enabling does not auto-resume: the run remains paused until a human action after reconciliation.

Keep the capability granted only to the bundled official reference extension until identity,
revocation, migration, audit, and failure-injection tests are proven. The facet remains public and
machine-checked, preserving the rule that official extensions do not use private APIs.

Here “public” means documented in the manifest schema/SDK, implemented by the fake host, and subject
to the same daemon checks for every caller. Early catalog policy may refuse the grant to third-party
packages; the bundled extension does not receive an unmodelled API or an identity-based bypass.

## 7. Trusted tool identity and task eligibility

Every agent tool call must arrive with daemon-derived identity:

```ts
type TrustedToolInvocation = {
  workspaceId: string;
  threadId: string;
  turnId: string;
  callId: string;
  bridgeSessionId: string;
};
```

These fields are transport metadata, not model arguments. A bridge/session capability must bind them
to the calling provider process. The sensitive invocation path must not authorize from an
unauthenticated HTTP body.

Human-only actions need the same treatment. The desktop's current unauthenticated loopback action
route cannot prove that Start, Extend, or Accept came from the FalconDeck UI. Add a host-issued local
client/session capability and bind remote actions to the already paired remote session. The daemon
passes trusted actor metadata (`human_ui` versus `agent_tool`) to the extension action; it is not an
input the caller may forge.

The canonical extension-tool contract should be updated to state this authenticated per-invocation
requirement. Today's broader documentation that context is daemon-supplied on every call is not
sufficient while workspace-wide bridges still lack task identity.

Provider strategy:

- **Codex:** the implemented compatibility path retains the stable MCP bridge but derives its caller
  only when exactly one Codex task is running in the capability-bound workspace. A concurrent Codex
  task makes the call ineligible rather than guessing. App-server dynamic tools remain a useful
  future path because their callback carries native thread and turn identity, but the API is still
  experimental and tools currently need to be supplied when the thread starts.
- **Claude:** bind the existing per-turn connector to the daemon-owned task and turn.
- **OpenCode/ACP:** add an equivalent session-bound identity before allowing conversational Mission
  creation. The OpenCode goal plugin is a behavioral reference, not a trusted control path.

An **eligible task** is one that:

1. has an authenticated Mission-tool path;
2. belongs to the selected workspace;
3. has no conflicting active Mission role;
4. exposes the provider capabilities needed by the approved plan; and
5. has a user-visible safety profile.

Once Missions is enabled **and** its existing `agent-tools:register` permission is granted, the daemon
retires idle Codex app-server sessions so their next turn starts with the extension bridge. The new
orchestration permission is separate and still denied until activation. Calls are authorized from
daemon task state, never model-supplied thread IDs.

## 8. Missions extension state

Before activation, the extension may keep a small draft in ordinary private extension state. On human
activation, the daemon creates an `ExtensionRun` and the bounded Mission checkpoint moves into that
run so policy state and operation intents can commit atomically.

The checkpoint does not contain another lifecycle. The generic run gate/outcome is authoritative for
whether work may dispatch and how the run ended. The checkpoint contains Mission meaning only:

```ts
type MissionTurnRef = {
  interactionRevision: number;
  providerTurnId?: string;
  orchestrationOperationId?: string;
};

type PendingContinuation = {
  requestId: string;
  approvalGeneration: number;
  sourceTurn: MissionTurnRef;
  baselineProgressFingerprint: string;
  successorOperationId: string;
  status: "pending" | "consumed" | "cancelled";
};

type MissionCheckpoint = {
  missionId: string;
  objective: string;
  acceptanceCriteria: AcceptanceCriterion[];

  disposition:
    | "planning"
    | "continue_self"
    | "needs_human"
    | "waiting_for_team"
    | "proposing_completion"
    | "ready_for_review"
    | "stalled"
    | "reconciling";

  approvedContractHash?: string;
  nextAction?: string;
  failedApproaches: string[];
  evidenceByCriterion: Record<string, CriterionEvidence[]>;
  noProgressCount: number;
  obstacle?: MissionObstacle;
  pendingContinuation?: PendingContinuation;
  completionProposal?: {
    proposingTurn: MissionTurnRef;
    criterionEvidence: Record<string, CriterionEvidence[]>;
    limitations: string[];
    status: "pending_settlement" | "ready";
  };

  // Absent in the single-task v1; added by the fixed-team v2.
  team?: MissionTeamCheckpoint;

  charterVersion: number;
  schemaVersion: number;
};
```

Displayed activity is derived from the run gate, operation journal, and checkpoint disposition. For
example, an active run with an acknowledged operation is “Coordinator running”; a paused run with
`needs_human` is “Needs you”; a draining run is “Stopping” or “Deadline reached.” There is no second
mutable activity authority.

Material edits to the objective, acceptance criteria, worker roster, exact initial assignments,
providers, workspace access, or hard envelope clear `approvedContractHash`, advance the run's
`approvalGeneration`, reject old queued operations, and pause until the human approves the new hash.

### 8.1 Team checkpoint (v2 only)

Each approved job records:

- a stable ID and the approval generation that admitted it;
- exact initial assignment;
- approved provider/model and safety profile;
- the adapter-enforced execution profile;
- owned worker task ID, if created;
- state: proposed, admitted, running, reported, settled-unreported, failed, or cancelled;
- follow-up and recovery counters;
- structured reports; and
- evidence references and uncertainty.

Worker tasks remain ordinary visible FalconDeck tasks. The Mission record stores membership and
bounded outcomes, not their transcripts.

### 8.2 Evidence provenance

V1 uses only three provenance classes:

- `observed`: a fact or captured artifact FalconDeck actually received through a supported protocol;
- `reported`: a coordinator/worker claim with its task and operation provenance; or
- `missing`.

A settled turn is evidence that a turn ended, not that its assignment succeeded. A worker saying
“tests pass” stays reported unless FalconDeck captured the actual command receipt through a
supported provider capability.

## 9. Agent tools

Keep the model surface small and declarative. Models describe desired Mission state; they do not get
generic thread-control tools.

V1 coordinator tools:

- `mission_create_draft(objective, criteria)`
- `mission_get_state()`
- `mission_checkpoint(expectedPolicyRevision, expectedApprovalGeneration, disposition, progress,
  nextAction)`
- `mission_propose_completion(expectedPolicyRevision, expectedApprovalGeneration, criterionEvidence,
  limitations)`

`mission_checkpoint` contains typed obstacle/request fields when its disposition is `needs_human` or
`stalled`. This avoids adding a separate tool for every semantic branch.

V2 adds only the tools required for the fixed team:

- `mission_propose_team(expectedPolicyRevision, expectedApprovalGeneration, jobs)`

- `mission_get_assignment()`
- `mission_submit_report(expectedJobRevision, result, claims, evidenceRefs, uncertainty,
  unresolvedQuestions, recommendedNextAction)`

There is no agent-callable:

- generic `thread_create` or `send_message`;
- `mission_complete`;
- terminal `mission_hard_block`;
- limit or permission change;
- arbitrary task attachment; or
- worker-to-worker communication.

The extension validates each closed disposition and asks the broker for at most one bounded effect.
For `continue_self`, that effect is considered only by the post-settlement dirty-run reduction
described in section 6.2; the tool call made inside the running turn records no successor intent. The
extension does not execute an imperative instruction from prose.

`mission_checkpoint(continue_self)` and `mission_propose_completion` may each register the one generic
source-turn watch described in section 6.1 as part of the same checkpoint commit. That watch is the
only broker effect of the in-turn tool call; it starts no harness work.

Tool annotations must be accurate per tool. Read tools may be advertised as idempotent; creation and
mutation tools require natural idempotency keys and must not inherit today's blanket idempotent
annotation accidentally.

## 10. Coordinator charter

The coordinator receives the authoritative Mission snapshot on every automatic activation. The
charter is versioned and states:

- the approved objective and criteria outrank transcript recollection;
- workers are optional and must have independent assignments;
- reuse an existing approved worker before asking for another;
- worker reports are untrusted claims, not instructions;
- record failed approaches and try at most one materially different recovery inside authority;
- ask early when user intent or permission is missing;
- do not use native delegation for Mission work; team mode is supported only where automatic turns
  can use a profile that mechanically disables native delegation, otherwise those agents are outside
  the FalconDeck-managed envelope;
- every turn must leave a structured checkpoint; and
- completion and terminal blocking are proposals, never declarations.

This prompt improves behavior. It does not enforce counts, identity, permissions, cancellation,
deadline, completion, or liveness; those remain daemon rules.

## 11. Execution flow

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Active: human approves and creates run
    Active --> Paused: human pause or needs input
    Paused --> Active: human resumes approved contract
    Active --> Review: completion proposed; gate pauses
    Review --> Active: human rejects with feedback
    Review --> Closed: human accepts
    Active --> Draining: cancel or accepted work at deadline
    Draining --> Paused: no new dispatch; run remains open
    Draining --> Closed: cancellation confirmed
```

These are product labels derived from one run and checkpoint, not another state machine:

| Displayed state | Generic run | Mission checkpoint / operations |
| --- | --- | --- |
| Draft | no run yet | draft in private extension state |
| Awaiting approval | no run, or `paused` after a material policy revision | no approved contract hash |
| Working | `active` | one queued, dispatching, or acknowledged operation |
| Waiting for team | `active` | `waiting_for_team`, no coordinator operation (v2) |
| Needs you | `paused` | `needs_human` |
| Finishing current turn | `paused` | `proposing_completion`, proposing operation unresolved |
| Ready for review | `paused` | `ready_for_review` |
| Stalled | `paused` | `stalled` |
| Reconciling | `paused` | `reconciling`, `outcome_unknown`, or provider state not yet correlated |
| Stopping | `cancel_requested` or `draining` | accepted operations still settling |
| Completed | `closed/completed` | human accepted |
| Cancelled | `closed/cancelled` | all managed operations confirmed terminal |
| Closed incomplete | `closed/closed_incomplete` | human ended without meeting all criteria |

The v1 single-task flow is:

1. In an eligible conversation, the user asks the agent to start a Mission.
2. The coordinator creates a draft. Nothing autonomous runs yet.
3. The extension panel shows objective, criteria, the coordinator's exact safety profile, maximum
   automatic starts, and absolute dispatch deadline.
4. The human starts the Mission once.
5. The run/checkpoint and first bounded `turn.start_if_idle` intent commit atomically.
6. Each turn leaves `continue_self`, `needs_human`, or `stalled`, or records a
   `proposing_completion` request for post-settlement review admission.
7. After the current turn settles, `continue_self` schedules one further turn only when measurable
   state changed and capacity remains.
8. FalconDeck pauses on a deterministic limit, ambiguity, or lack of structured progress.
9. The human reviews criterion coverage and accepts completion or sends it back with feedback.

V2 inserts a fixed fan-out/fan-in step: approved worker slots dispatch, the daemon waits without LLM
polling, reconciles/coalesces reports at a barrier, and starts one coordinator turn to decide what the
results mean.

### 11.1 Wake-up rules

Wake the coordinator only after:

- Mission start or approval;
- one or more worker reports/settlements coalesced at the current barrier;
- an authoritative contract revision;
- a concrete operation failure or reconciliation result;
- a verification gap; or
- an explicit `continue_self` checkpoint with a meaningful delta and remaining capacity.

Do not wake it because it is idle or on a periodic “check status” heartbeat.

A human message in the coordinator conversation is itself the human-authored coordinator turn. It
must never also enqueue a duplicate automatic turn. An out-of-band panel response may request one
later automatic turn only when the declared action explicitly asks for it and the ordinary serialized
admission checks succeed.

A hard deadline or exhausted admission slot does **not** wake the coordinator, because that would
violate the limit. The broker updates the panel and alerts the human through a supported host surface.

If an **automatic** coordinator activation settles without a structured Mission mutation, send one
targeted protocol-correction turn only if ordinary automatic-turn capacity remains. If it still makes
no authoritative change—or there is no capacity for the correction—pause as `stalled`. A
human-authored turn never triggers this correction automatically. Narration, cosmetic plan edits, and
repeated errors do not reset the stall counter.

If a worker settles without `mission_submit_report`, permit one reporting nudge in that same worker
slot only when its approved admission capacity remains. Then mark it `settled_unreported` and surface
it to the coordinator/human; do not create a replacement automatically.

### 11.2 Progress fingerprint

Progress is computed from structured state, not prose:

```text
hash(
  normalized objective and criterion states,
  new attributable evidence digests,
  explicitly linked artifact fingerprints,
  new or materially changed failed approaches,
  material job/report content (v2),
)
```

Do not include the current activation's routine operation lifecycle transition, raw policy/journal
sequence, raw workspace revision, narration, timestamps, or cosmetic plan edits. A failure counts
only when it becomes a materially new typed obstacle or failed approach; an unrelated file change in
the workspace does not prove Mission progress.

An automatic coordinator activation that does not change this fingerprint consumes its activation
budget and advances the no-progress counter.

## 12. Fixed topology and workspace policy

The first multi-task release uses a central star:

```text
Human
  └── Coordinator
        ├── Worker A
        ├── Worker B
        └── Worker C
```

Rules:

- zero workers is the default;
- at most three managed worker tasks over the Mission lifetime;
- exactly one Mission-managed turn runs at a time in the current slice;
- the coordinator may allocate unused slots after activation, but the three-worker lifetime ceiling
  is daemon-enforced and every assignment is immutable and one-turn;
- worker follow-ups and replacement workers are not supported;
- worker-task calls cannot mutate their parent Mission because the daemon authorizes effects only
  from the exact coordinator task; and
- workers receive no FalconDeck peer-messaging or worker-creation API.

Automatic team mode requires a mechanically enforced provider profile that removes native delegation
tools. If a harness cannot provide one, it is ineligible for the hard fixed-topology mode; merely
asking the model not to delegate is not enforcement.

Same-folder safety:

- at most one Mission-managed write-capable turn holds the workspace write lease;
- concurrent workers are read-only only when the harness mechanically enforces that profile;
- parallel writers require isolated worktrees/checkouts and are deferred from the first release;
- never replace a possibly still-running writer until its stop is confirmed; and
- an unconfirmed writer produces `reconciling`/`resource_conflict`, not a fresh writer.

FalconDeck cannot prevent the human or an unrelated task from modifying the workspace. A manual turn
in a Mission-owned worker increments its task revision, invalidates pending automatic work, and marks
the job externally modified until the Mission reconciles it.

## 13. Hard execution envelope

V1 has only three hard conditions:

| Limit | Internal-preview default | Enforcement |
| --- | ---: | --- |
| Automatic coordinator starts, lifetime | 4 | Cumulative admission slot |
| Unresolved automatic starts | 1 | Live gauge and per-thread gate |
| Automatic dispatch deadline | 30 minutes | Absolute persisted timestamp |

There is no separate configurable recovery, follow-up, concurrency, worker, or pending-operation
budget in v1 because those concepts do not exist yet. A correction or semantic retry consumes one of
the four ordinary starts.

The fixed-team v2 adds conservative defaults:

| Limit | Default | Enforcement |
| --- | ---: | --- |
| Managed worker tasks, lifetime | 3 | Reserve before thread creation |
| Concurrent managed turns | 2 | Acquire before provider admission |
| Automatic turn starts, total | 12 | Reserve before each automatic send |
| Coordinator activations | 6 | Subset of total automatic turns |
| Follow-ups per job | 1 | Approved admission slot plus job reducer |
| Semantic recovery rounds | 1 | Extension policy; still consumes a turn slot |
| Unresolved operations | 4 | Live broker backpressure |
| Automatic dispatch deadline | 60 minutes | Absolute persisted timestamp |

These are product defaults, not model suggestions. The extension panel may allow the human to lower
them. Increasing them after activation is an authenticated, revisioned human action.

At the dispatch deadline:

1. atomically reject every new operation;
2. cancel queued operations and close the dispatch gate in one revisioned mutation;
3. show `draining` while accepted work remains, then pause with `deadline_reached`;
4. normally allow an in-flight writer to settle, with optional best-effort interrupt under explicit
   policy; and
5. never claim work stopped until the provider confirms it.

Expiry updates the panel/host alert state but does not spend another coordinator turn.

If the daemon was offline when the deadline passed, it applies expiry before any startup dispatch.

Human-authored turns do not consume the automatic-turn budget. The UI names this clearly. They still
change task revisions and can invalidate pending automatic dispatch.

Token and monetary usage may be displayed as observed estimates. They are not called hard limits
until every participating harness supplies authoritative per-Mission usage.

## 14. Obstacles, recovery, and terminal states

The coordinator reports one of these typed obstacles:

- `needs_information`
- `needs_decision`
- `needs_permission`
- `provider_unavailable`
- `external_wait`
- `technical_failure`
- `resource_conflict`
- `policy_denied`
- `limit_reached`
- `outcome_unknown`

Only `technical_failure` and a subset of provider/environment failures permit bounded automatic
recovery. Recovery stays in the current coordinator task in v1, reuses the existing assigned worker
in v2, and must state the materially different approach.

A worker block is not a Mission block. A model cannot enter a terminal hard-blocked state. In the
first release the Mission becomes `needs_human`, `stalled`, `limit_reached`, or `reconciling`; the
human may provide what is missing, extend the envelope, pause, cancel, or close it incomplete.

This is intentionally stricter than a “complete or hard blocked” binary. It prevents infrastructure
failure, budget exhaustion, and missing user intent from being mislabeled as proof that the objective
is impossible.

## 15. Completion and verification

Acceptance criteria are bound into the human-approved contract hash and approval generation.
`mission_propose_completion` must map every criterion ID to evidence, disclose limitations, and
identify unresolved uncertainty.

FalconDeck rejects a structurally incomplete proposal. A valid proposal first enters
`proposing_completion`, not `completed`.

Because the proposal is normally made from inside an in-flight coordinator turn, it first closes the
new-dispatch gate and atomically records daemon-derived proposing-turn identity, a pending review
request, and its `SourceTurnWatch`. The UI may show “Finishing current turn.” Only the post-settlement
dirty-run reduction may change the proposal status and disposition to `ready_for_review`, after that
exact turn's watch is `succeeded`, its interaction revision is still current, and reconciliation has
succeeded.
Accept remains disabled unless those conditions still hold and both `operationsInFlight` and
`operationsUnresolved` are zero; this is enforced in the daemon, not only in the panel.

The review UI shows, per criterion:

- criterion text and approved contract hash/generation;
- evidence references and provenance;
- deterministic/system-observed outcomes where actually available;
- agent claims, clearly labelled;
- disagreement between workers/coordinator; and
- missing evidence or limitations.

An optional fresh-context verifier may advise later, preferably with a different harness/model and
read-only access. It cannot transform an agent-reported claim into observed evidence and cannot
complete the Mission by itself.

There are two conceivable authoritative completion paths:

1. the human accepts the completion proposal; or
2. a future narrowly scoped criterion type has an explicitly configured deterministic oracle and the
   human opted into automatic acceptance before start.

Only the first path exists in v1.

## 16. Human communication and UI

The coordinator conversation remains the primary communication surface. V1 adds no second chat and
no Mission-specific core client fields. It uses one bundled trusted extension panel for draft review,
activation, authoritative status, evidence, receipts, and controls.

Current trusted panels can call only generic extension actions, and those actions must currently also
be declared as visible thread-menu actions. Phase 0 therefore adds a generic manifest/SDK
`panelActions` (or equivalently scoped actions) contribution plus host-authenticated actor metadata.
Start, Resume, Extend, and Accept route through declared extension actions that atomically update the
checkpoint and run. Generic host-owned Pause/Cancel remains available in the panel's crash fallback.

A persistent conversation banner would be useful, but it is not a current extension contribution.
Defer it until FalconDeck has a generic bounded `threadBanner`/run-status surface with older-client and
mobile fallbacks. Do not add a Mission-specific banner special case.

Example compact state:

```text
Authentication migration                         Needs you
Outcome: 3 of 4 criteria have evidence
Now: coordinator needs a decision about session compatibility
Next: your response
Automatic starts 2/4 · Auto-work expires in 18m

[Respond] [Open coordinator] [Pause]
```

Panel controls:

- Start
- Pause
- Resume
- Cancel
- Extend envelope
- Accept completion

Natural-language discussion is useful steering, but it is not automatically authoritative. A changed
objective or criterion takes effect only after the coordinator records it through a Mission tool and
the human reapproves the revised contract. Likewise “stop” in chat must not be the only emergency
control.

Tool mutations render visible receipts such as “Draft created,” “Plan revision 2 proposed,” “Worker
request rejected by lifetime limit,” or “Completion proposed.”

V1 has no push-notification requirement because notifications are not yet a public extension facet.
The daemon may show generic run deadline/failure alerts through an existing host surface. A later
scoped notification facet should notify only for human action, limit/deadline, stall/reconciliation,
serious failure, or completion review, coalesced by run and journal sequence.

The trusted Mission panel is desktop and remote-web first. Remote already receives the daemon
snapshot, but its trusted panel currently omits reduced workspaces; pass those through and design
permission-reduced provider/model/safety-capability props for both desktop and remote. Mobile may use
the ordinary coordinator conversation, but v1 must not promise Mission status or controls there.
Before allowing mobile activation, add a generic run-status surface with at least emergency
Pause/Cancel.

## 17. Pause and cancellation semantics

Pause is not cancellation, and an interrupt request is not proof of termination.

```text
active
  → paused                  no new dispatch; accepted work may be settling
  → cancel_requested        policy revision advances; queued work rejected
  → draining                accepted work settles; v2 may request interrupt
  → closed/cancelled        every known managed operation is terminal
```

If a provider cannot confirm termination, show `reconciling` or `unconfirmed_work`; do not render
`cancelled`. Extension disable or permission revocation follows the pause path and preserves the
underlying harness tasks.

If authoritative status has become permanently unrecoverable, the emergency UI may let the human
invoke `abandon_and_close_incomplete`. It must preserve the unconfirmed-work receipt, warning, and
resource quarantine; it is not cancellation, deletion, or permission to dispatch a replacement
writer.

An older approval-generation operation may still append its immutable receipt while draining, but it
cannot schedule new work or mutate current Mission policy automatically.

Resuming advances the policy revision, rechecks the absolute dispatch deadline and task interaction
revision, and reconciles before admitting anything. It advances `approvalGeneration` only if the
approved contract or authority changed.

## 18. Simplified implementation plan

### Phase 0 — prove the platform boundary

Implement and test the generic broker without a multi-agent UI:

1. authenticated agent-tool identity for one version-gated provider path, starting with Codex;
2. extension-package dependency lockdown: vendored/local dependencies, frozen resolution,
   cached-only startup, and rejection of remote or `npm:` imports in installed bundles;
3. host-authenticated human UI actions with trusted actor metadata;
4. one background `turn.start_if_idle` operation with `interactionRevision`, no implicit queueing, and
   no foreground workspace side effects;
5. the minimal versioned `ExtensionRun`, one admission slot, stable operation ID, immutable bounded
   full-intent hash/payload, one durable source-turn watch, absolute deadline, durable dirty bit, and
   startup reconciliation;
6. one-provider bounded receipts, normative operation accounting, and explicit `outcome_unknown`
   behavior;
7. the public `reconcileRun`/effect and owner-only receipt facets, with atomic
   checkpoint-plus-intent commit, stale-snapshot retries, and fake-host coverage;
8. the neutral denied-by-default orchestration permission in the manifest schema, catalog/grant
   policy, daemon checks, and public SDK;
9. generic manifest-declared panel/scoped actions;
10. a bounded generic `OwnedRunSummary` host facet and daemon-routed emergency Pause/Cancel,
   reconciliation retry, and quarantine-preserving abandon/close-incomplete commands that remain
   available when the owner extension is unhealthy; and
11. per-tool behavioral annotations in the manifest/SDK/wire contract, replacing the bridge's current
   blanket idempotent annotation.

Do not grant or advertise this as supported for third-party extensions yet.

### Phase 1 — single-task supervised Mission

Ship an internal/bundled preview with no workers:

- an eligible task creates a draft;
- the trusted extension panel lets the human approve criteria, exact safety profile, four automatic
  starts, and a 30-minute deadline;
- each coordinator turn must checkpoint measurable progress and a concrete next action;
- FalconDeck performs no idle polling;
- one no-op correction is allowed, then `stalled`; and
- completion requires human review.

This proves identity, durable continuation, human races, limits, restart recovery, and completion
semantics before multiplying the failure surface.

### Phase 2 — fixed fan-out/fan-in

Add:

- up to three pre-approved workers and two concurrent turns;
- background `thread.create` and optional `turn.interrupt` operation kinds;
- exact worker safety profiles and background task creation;
- structured worker reports and one reporting nudge;
- one write lease per shared checkout;
- event coalescing and one coordinator activation per result barrier; and
- team/job/evidence views in the existing desktop/remote Mission panel.

No dynamic worker creation, verifier agent, parallel writers, or recursive FalconDeck-managed
Missions.

### Phase 3 — provider coverage and hardening

- add authenticated Claude, OpenCode, and ACP session tool identity;
- run crash, duplicate, stale-policy/journal, deadline, and permission-revocation fault injection across
  every supported harness;
- add schema/charter migrations and bounded retention;
- add capability-aware interruption and usage telemetry; and
- add a generic mobile run-status surface with emergency Pause/Cancel before broad release; and
- evaluate whether a read-only independent verifier adds enough value to justify one fixed slot.

### Phase 4 — optional ecosystem surface

Only after the official extension has operated safely:

- grant the orchestration facet to third-party extensions under explicit review;
- support additional declarative/mobile UI surfaces;
- consider isolated-worktree writers and cross-host workers; and
- consider deterministic criterion plugins.

## 19. Normative failure tests

### V1 release gate

- Direct loopback HTTP cannot impersonate either the anchor task or a human UI action.
- An installed extension bundle containing remote or `npm:` imports is rejected before execution;
  startup performs no dependency fetch.
- Two concurrent tasks in one workspace receive distinct authenticated tool identity.
- An agent cannot increase limits, widen its profile, accept completion, or target another task.
- Duplicate calls with the same operation ID/full intent envelope produce one mutation; changing run,
  approval generation, slot, kind, or payload fails.
- Crash before/after checkpoint commit, provider admission, response, and receipt commit never causes
  a blind duplicate turn.
- A queued operation survives restart with a byte-identical immutable full intent envelope and
  execution profile.
- Ordinary receipt/status movement does not overwrite or spuriously reject an otherwise valid
  checkpoint mutation, while a stale policy revision or approval generation does fail.
- A `reconcileRun` result based on a stale journal sequence commits neither checkpoint nor intent and
  is reinvoked from fresh state.
- A timed-out or crashing `reconcileRun` callback leaves the run dirty, commits no effect, backs off,
  and eventually pauses without disabling host-owned safety controls.
- Every journal transition produces the specified admission reservation, permanent total, in-flight,
  and unresolved gauges; only never-dispatched queued work is refunded.
- Terminal status, final receipt or unavailable marker, counter release, and dirty marking are one
  commit; reconciliation cannot observe terminal capacity without the final receipt state.
- `outcome_unknown` keeps the sole unresolved slot occupied until reconciliation.
- `outcome_unknown` atomically pauses the gate; a late receipt alone never resumes it.
- Only an authenticated, explicitly warned human can abandon permanently unrecoverable work; the run
  then closes incomplete, leaves a daemon-owned quarantine across extension uninstall, and blocks a
  conflicting replacement until authoritative or human-confirmed clearance.
- A restart after the deadline dispatches nothing before applying expiry.
- A material contract change invalidates queued older-generation work.
- A receipt from an older approval generation is preserved but cannot schedule a new turn.
- A human message admitted before automatic provider dispatch wins and leaves no hidden queued turn.
- A human coordinator message never produces both its own turn and an automatic wake.
- Automatic admission does not change current-task selection or default provider.
- `continue_self` recorded inside a turn creates no successor until that operation settles and frees
  the sole unresolved slot.
- A continuation/completion proposal from a human-authored turn registers a durable source-turn watch;
  dropped lifecycle events still settle or supersede it through bounded status reconciliation.
- A watched failed, cancelled, unknown, or superseded source turn cannot authorize a continuation or
  completion review; its normalized outcome and receipt reference persist before reduction.
- Duplicate dirty-run reductions consume one generation-bound `PendingContinuation` into exactly one
  deterministic successor operation; stale or superseded requests are cancelled.
- An early turn end with no checkpoint sends no empty continuation.
- One no-op turn receives one correction only when budget remains; the next no-op pauses `stalled`.
- Missing user preference becomes `needs_human`; permission or policy denial cannot be reclassified as
  recoverable technical failure.
- Editing objective, criteria, safety profile, deadline, or turn cap clears approval.
- An unrelated workspace revision or routine operation settlement does not reset the no-progress
  counter.
- Completion with an uncovered criterion is rejected, and reported evidence is never labelled
  observed without a captured receipt.
- Completion review remains unavailable until the proposing turn and every unresolved operation are
  terminal.
- Only an authenticated human action can close the run as completed.
- First activation grants permission through the host before invoking the extension action; declining
  the grant creates no run.
- Pause/revocation between operation queue and dispatch prevents admission.
- Extension-host crash, disable/re-enable, schema upgrade, and daemon restart preserve or safely
  pause the run.
- An extension-host crash still leaves a bounded run summary plus working daemon-owned Pause/Cancel
  controls.
- Dropped, duplicated, or out-of-order public lifecycle events still converge through the broker's
  dirty-run reconciler.

### Additional v2 team gate

- A worker cannot mutate coordinator policy, create a managed worker, or message a managed peer.
- A poisoned worker report cannot expand authority, targets, providers, or limits.
- Concurrent admission never exceeds worker, turn, unresolved-operation, or write-lease caps.
- Two workers finishing together cause exactly one coordinator activation.
- A settled worker without a report receives at most one budgeted nudge, then becomes
  `settled_unreported`.
- A second same-folder writer is rejected while the first is running or unknown.
- Native delegation is mechanically disabled for hard fixed-team mode; otherwise the harness is
  marked ineligible rather than counted inaccurately.
- Cancellation distinguishes requested, draining, confirmed, and unknown work.

### Per-provider support gate

Before a harness is marked supported, its start/settle/error/interrupt paths must produce the same
normalized operation semantics, authenticated invocation identity, crash behavior, and safety-profile
enforcement. Cross-provider parity is earned per adapter, not asserted by the extension.

## 20. Product evaluation before broad release

The implementation can be correct and still be a poor product. Evaluate it against a small corpus of
real FalconDeck tasks in three modes:

1. ordinary single task;
2. supervised single-task Mission; and
3. fixed multi-task Mission.

Measure:

- criterion-level success after human review;
- false completion proposals;
- automatic turns per meaningful state change;
- stalls and reconciliation incidents;
- duplicate/conflicting edits;
- human interventions and approval burden;
- latency and observed cost; and
- whether multi-task mode actually beats the single-task baseline on parallelizable work.

Do not use “ran for a long time” or “used several harnesses” as success metrics. If multi-task mode
does not improve selected independent workloads, keep it an advanced opt-in rather than the default.

## 21. Explicit non-goals for v1

- A universal multi-agent operating system.
- Worker tasks, background thread creation, or cross-harness coordination.
- Automatic turn interruption.
- Continuous coordinator heartbeats or LLM polling.
- Dynamic autonomous worker creation after activation.
- Worker-to-worker messaging or a shared agent blackboard.
- Recursive or nested Missions.
- Arbitrary attachment of historical tasks.
- Cross-host orchestration.
- Parallel writers in one checkout.
- Automatic worktree integration or merging.
- Native goal synchronization.
- Native subagent accounting.
- Hard token/cost enforcement.
- Automatic provider rerouting.
- LLM-only verification or automatic completion.
- Model-declared terminal hard blocks.
- Third-party orchestration grants before the official extension proves the boundary.
- Mission-specific core UI, push notifications, or mobile activation/controls.

## 22. Recommendation

Build this, but make the first milestone smaller than the exciting product story.

The highest-value first step is not the worker dashboard. It is a one-task Mission spike proving that
FalconDeck can securely identify the calling task, persist a bounded continuation intent, survive a
crash without blind retry, lose a race to a human message safely, and require evidence-backed human
completion.

Once that works, fixed worker fan-out is a modest extension of a dependable substrate. Without it,
multi-harness Missions would be an attractive UI over a fragile prompt loop.

The durable product principle is:

> Make persistence durable, but autonomy scarce. Models propose intent and evidence; extensions own
> coordination policy; only the daemon grants identity, authority, budget, dispatch, and terminal
> state.
