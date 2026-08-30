import {
  defineExtension,
  defineExtensionUi,
  type ExtensionContext,
  type ExtensionRunSummary,
  type ExtensionThreadSummary,
  type ExtensionUiNode,
} from "@falcondeck/extension-sdk";

const PANEL_VIEW = "missions-panel";
const DRAFTS_KEY = "missionDrafts";
const MAX_DRAFTS = 20;

type MissionDraft = {
  id: string;
  workspaceId: string;
  threadId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  createdAt: string;
};

type MissionCheckpoint = {
  schemaVersion: 1;
  objective: string;
  acceptanceCriteria: string[];
  disposition:
    | "planning"
    | "continue_self"
    | "awaiting_workers"
    | "needs_human"
    | "proposing_completion";
  summary: string;
  nextAction?: string;
  evidence: string[];
  limitations: string[];
  humanQuestion?: string;
  updatedAt: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("action input must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  label: string,
  max: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if ([...normalized].length > max) {
    throw new Error(`${label} must be at most ${max} characters`);
  }
  return normalized;
}

function stringList(value: unknown, label: string, maxItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must be an array of at most ${maxItems} strings`);
  }
  return value.map((item, index) =>
    requiredString(item, `${label}[${index}]`, 1000),
  );
}

function checkpointOf(run: ExtensionRunSummary): MissionCheckpoint {
  const candidate = run.checkpoint as Partial<MissionCheckpoint> | null;
  return {
    schemaVersion: 1,
    objective:
      typeof candidate?.objective === "string"
        ? candidate.objective
        : run.objective,
    acceptanceCriteria: Array.isArray(candidate?.acceptanceCriteria)
      ? candidate.acceptanceCriteria.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    disposition:
      candidate?.disposition === "continue_self" ||
      candidate?.disposition === "awaiting_workers" ||
      candidate?.disposition === "needs_human" ||
      candidate?.disposition === "proposing_completion"
        ? candidate.disposition
        : "planning",
    summary: typeof candidate?.summary === "string" ? candidate.summary : "",
    ...(typeof candidate?.nextAction === "string"
      ? { nextAction: candidate.nextAction }
      : {}),
    evidence: Array.isArray(candidate?.evidence)
      ? candidate.evidence.filter((item): item is string => typeof item === "string")
      : [],
    limitations: Array.isArray(candidate?.limitations)
      ? candidate.limitations.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    ...(typeof candidate?.humanQuestion === "string"
      ? { humanQuestion: candidate.humanQuestion }
      : {}),
    updatedAt:
      typeof candidate?.updatedAt === "string"
        ? candidate.updatedAt
        : run.updatedAt,
  };
}

function statusLabel(run: ExtensionRunSummary): string {
  if (run.gate === "closed") {
    return run.outcome === "completed" ? "Complete" : "Closed";
  }
  if (run.gate === "paused") {
    if (run.completionProposed) return "Ready for review";
    if (
      run.operations.some((operation) =>
        ["dispatching", "acknowledged"].includes(operation.status),
      )
    ) {
      return "Coordinator settling";
    }
    return "Paused";
  }
  if (run.awaitingWorkers) return "Workers running";
  const active = run.operations.at(-1)?.status;
  return active === "acknowledged" || active === "dispatching"
    ? "Coordinator running"
    : active === "queued"
      ? "Waiting to continue"
      : "Active";
}

function toneFor(run: ExtensionRunSummary) {
  if (run.outcome === "completed") return "success" as const;
  if (run.gate === "closed") return "gray" as const;
  if (run.gate === "paused") return "warning" as const;
  return "accent" as const;
}

function runControls(run: ExtensionRunSummary): ExtensionUiNode[] {
  if (run.gate === "closed") return [];
  const input = { runId: run.id, expectedPolicyRevision: run.policyRevision };
  const hasUnknownOutcome =
    run.operations.some(
      (operation) => operation.status === "outcome_unknown",
    ) || run.workers.some((worker) => worker.status === "outcome_unknown");
  if (hasUnknownOutcome) {
    return [
      {
        type: "button",
        label: "Close incomplete",
        variant: "danger",
        action: { actionId: "close-incomplete", input },
      },
    ];
  }
  if (run.completionProposed && run.gate === "paused") {
    return [
      {
        type: "button",
        label: "Accept completion",
        variant: "primary",
        action: { actionId: "accept-completion", input },
      },
      {
        type: "button",
        label: "Close incomplete",
        variant: "danger",
        action: { actionId: "close-incomplete", input },
      },
    ];
  }
  const coordinatorSettling = run.operations.some((operation) =>
    ["dispatching", "acknowledged"].includes(operation.status),
  );
  if (run.gate === "paused" && coordinatorSettling) {
    return [
      {
        type: "button",
        label: "Extend 30 min",
        action: { actionId: "extend-run", input },
      },
      {
        type: "button",
        label: "Close incomplete",
        variant: "danger",
        action: { actionId: "close-incomplete", input },
      },
    ];
  }
  return [
    run.gate === "open"
      ? {
          type: "button",
          label: "Pause",
          action: { actionId: "pause-run", input },
        }
      : {
          type: "button",
          label: "Resume",
          variant: "primary",
          action: { actionId: "resume-run", input },
        },
    {
      type: "button",
      label: "Extend 30 min",
      action: { actionId: "extend-run", input },
    },
    {
      type: "button",
      label: "Close incomplete",
      variant: "danger",
      action: { actionId: "close-incomplete", input },
    },
  ];
}

function runNode(run: ExtensionRunSummary): ExtensionUiNode {
  const checkpoint = checkpointOf(run);
  return {
    type: "stack",
    gap: "small",
    children: [
      {
        type: "row",
        gap: "small",
        wrap: true,
        children: [
          { type: "text", text: run.title, style: "heading" },
          { type: "badge", text: statusLabel(run), tone: toneFor(run) },
          {
            type: "badge",
            text: `${run.automaticTurnsStarted}/${run.maxAutomaticTurns} automatic turns`,
            tone: "muted",
          },
          {
            type: "badge",
            text: `${run.workers.length}/${run.maxWorkers} workers`,
            tone: "muted",
          },
        ],
      },
      { type: "text", text: run.objective },
      ...(checkpoint.summary
        ? [
            {
              type: "text" as const,
              text: checkpoint.summary,
              tone: "muted" as const,
            },
          ]
        : []),
      ...(run.pauseReason
        ? [
            {
              type: "text" as const,
              text: run.pauseReason,
              tone: "warning" as const,
            },
          ]
        : []),
      ...run.workers.map((worker) => ({
        type: "text" as const,
        text: `Worker ${worker.id.slice(0, 8)} · ${worker.provider} · ${worker.status.replaceAll("_", " ")}`,
        style: "caption" as const,
        tone:
          worker.status === "failed" || worker.status === "outcome_unknown"
            ? ("warning" as const)
            : ("muted" as const),
      })),
      ...(run.gate === "paused" && !run.completionProposed
        ? [
            {
              type: "text" as const,
              text:
                run.operations.some(
                  (operation) => operation.status === "outcome_unknown",
                ) ||
                run.workers.some(
                  (worker) => worker.status === "outcome_unknown",
                )
                  ? "FalconDeck will not retry an ambiguous provider operation. Review the coordinator and worker tasks, then close this Mission if its outcome cannot be proved."
                  : "Resume here before continuing the conversation in the coordinator task.",
              style: "caption" as const,
              tone: "muted" as const,
            },
          ]
        : []),
      {
        type: "text",
        text: `Deadline ${new Date(run.deadlineAt).toLocaleString()}`,
        style: "caption",
        tone: "muted",
      },
      { type: "row", gap: "small", wrap: true, children: runControls(run) },
      { type: "divider" },
    ],
  };
}

function draftNode(draft: MissionDraft): ExtensionUiNode {
  return {
    type: "stack",
    gap: "small",
    children: [
      { type: "text", text: draft.title, style: "heading" },
      { type: "text", text: draft.objective },
      {
        type: "text",
        text: `${draft.acceptanceCriteria.length} acceptance criteria · no work starts until you confirm`,
        tone: "muted",
      },
      {
        type: "button",
        label: "Start bounded mission",
        variant: "primary",
        action: { actionId: "start-draft", input: { draftId: draft.id } },
      },
      { type: "divider" },
    ],
  };
}

function candidateNode(thread: ExtensionThreadSummary): ExtensionUiNode {
  return {
    type: "row",
    gap: "small",
    wrap: true,
    children: [
      { type: "text", text: thread.title },
      {
        type: "button",
        label: "Make coordinator",
        action: {
          actionId: "adopt-task",
          input: {
            workspaceId: thread.workspaceId,
            threadId: thread.id,
            title: thread.title,
          },
        },
      },
    ],
  };
}

function panel(
  runs: readonly ExtensionRunSummary[],
  drafts: readonly MissionDraft[],
  threads: readonly ExtensionThreadSummary[],
  notice?: string,
) {
  const occupied = new Set(
    runs
      .filter((run) => run.gate !== "closed")
      .map((run) => `${run.workspaceId}:${run.coordinatorThreadId}`),
  );
  const candidates = threads
    .filter(
      (thread) =>
        thread.status === "idle" &&
        (thread.provider === "claude" || thread.provider === "codex") &&
        !occupied.has(`${thread.workspaceId}:${thread.id}`),
    )
    .slice(0, 8);
  const visibleDrafts = drafts.filter(
    (draft) => !occupied.has(`${draft.workspaceId}:${draft.threadId}`),
  );
  const children: ExtensionUiNode[] = [
    { type: "text", text: "Missions", style: "heading" },
    {
      type: "text",
      text: "A Mission keeps policy and limits above the harness while the full conversation stays in its coordinator task.",
      tone: "muted",
    },
    ...(notice
      ? [{ type: "text" as const, text: notice, tone: "info" as const }]
      : []),
    { type: "divider" },
  ];
  if (runs.length > 0) {
    children.push({ type: "text", text: "Runs", style: "heading" });
    children.push(...runs.slice(0, 12).map(runNode));
  }
  if (visibleDrafts.length > 0) {
    children.push({ type: "text", text: "Drafts", style: "heading" });
    children.push(...visibleDrafts.slice(0, 12).map(draftNode));
  }
  children.push({ type: "text", text: "Start from an idle task", style: "heading" });
  if (candidates.length === 0) {
    children.push({
      type: "state",
      state: "empty",
      title: "No eligible idle tasks",
      description: "Finish the current turn or create a Mission draft from an eligible task.",
    });
  } else {
    children.push({ type: "list", items: candidates.map(candidateNode) });
  }
  children.push({
    type: "button",
    label: "Refresh",
    action: { actionId: "refresh-missions", input: {} },
  });
  return defineExtensionUi({ version: 1, root: { type: "stack", gap: "large", children } });
}

function coordinatorPrompt(
  objective: string,
  acceptanceCriteria: readonly string[],
): string {
  const criteria = acceptanceCriteria.length
    ? acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. Verify the requested outcome with concrete evidence appropriate to the task.";
  return `You are coordinating a bounded FalconDeck Mission in this existing task.\n\nObjective:\n${objective}\n\nAcceptance criteria:\n${criteria}\n\nWork directly and conservatively. You may delegate at most three genuinely independent, one-turn assignments with the FalconDeck Mission delegate tool; workers run serially in separate Codex tasks and cannot delegate further. Prefer doing small or tightly coupled work yourself. After delegating, call the Mission checkpoint tool with awaiting_workers. Otherwise call it exactly once before finishing this turn: request one continuation only after meaningful durable progress, pause for human input when authority or intent is missing, or propose completion with criterion-level evidence. The Mission cannot become complete from prose alone. Never route around a denial, safety boundary, exhausted limit, or ambiguous user intent.`;
}

function continuationPrompt(nextAction: string): string {
  return `Continue the bounded FalconDeck Mission. The durable next action is:\n\n${nextAction}\n\nRe-read the task state, do the work, and call the Mission checkpoint tool exactly once before ending. Do not claim completion without concrete evidence for the acceptance criteria.`;
}

async function currentState(context: ExtensionContext) {
  const [runs, drafts, threads] = await Promise.all([
    context.orchestration.list(),
    context.storage.get<MissionDraft[]>(DRAFTS_KEY, []),
    context.threads.list(),
  ]);
  return { runs, drafts, threads };
}

async function publish(context: ExtensionContext, notice?: string) {
  const { runs, drafts, threads } = await currentState(context);
  const occupied = new Set(
    runs
      .filter((run) => run.gate !== "closed")
      .map((run) => `${run.workspaceId}:${run.coordinatorThreadId}`),
  );
  const retainedDrafts = drafts.filter(
    (draft) => !occupied.has(`${draft.workspaceId}:${draft.threadId}`),
  );
  if (retainedDrafts.length !== drafts.length) {
    await context.storage.set(DRAFTS_KEY, retainedDrafts);
  }
  await context.views.publish({
    viewId: PANEL_VIEW,
    value: panel(runs, retainedDrafts, threads, notice),
  });
}

function runInput(input: unknown) {
  const value = record(input);
  return {
    runId: requiredString(value.runId, "runId", 128),
    expectedPolicyRevision:
      typeof value.expectedPolicyRevision === "number"
        ? value.expectedPolicyRevision
        : (() => {
            throw new Error("expectedPolicyRevision is required");
          })(),
  };
}

export default defineExtension({
  activate(context) {
    context.actions.register("refresh-missions", async () => {
      await publish(context);
      return { refreshed: true };
    });

    context.actions.register("start-draft", async ({ input }) => {
      const draftId = requiredString(record(input).draftId, "draftId", 128);
      const drafts = await context.storage.get<MissionDraft[]>(DRAFTS_KEY, []);
      const draft = drafts.find((candidate) => candidate.id === draftId);
      if (!draft) throw new Error("mission draft no longer exists");
      const runId = crypto.randomUUID();
      const checkpoint: MissionCheckpoint = {
        schemaVersion: 1,
        objective: draft.objective,
        acceptanceCriteria: draft.acceptanceCriteria,
        disposition: "planning",
        summary: "Mission accepted; coordinator has not reported its first checkpoint yet.",
        evidence: [],
        limitations: [],
        updatedAt: new Date().toISOString(),
      };
      await context.orchestration.apply({
        type: "create_run",
        runId,
        workspaceId: draft.workspaceId,
        coordinatorThreadId: draft.threadId,
        title: draft.title,
        objective: draft.objective,
        checkpoint,
        initialPrompt: coordinatorPrompt(
          draft.objective,
          draft.acceptanceCriteria,
        ),
      });
      return { runId, started: true };
    });

    context.actions.register("adopt-task", async ({ input }) => {
      const value = record(input);
      const workspaceId = requiredString(value.workspaceId, "workspaceId", 512);
      const threadId = requiredString(value.threadId, "threadId", 512);
      const title = requiredString(value.title, "title", 120);
      const objective = `Complete and verify the objective already discussed in the task “${title}”. Preserve the task's existing conversational context and ask the human if the desired outcome is materially ambiguous.`;
      const runId = crypto.randomUUID();
      const checkpoint: MissionCheckpoint = {
        schemaVersion: 1,
        objective,
        acceptanceCriteria: [
          "The outcome discussed in the coordinator task is implemented or otherwise completed.",
          "Relevant verification is run and concrete evidence is reported for human review.",
        ],
        disposition: "planning",
        summary: "Mission accepted from an existing task.",
        evidence: [],
        limitations: [],
        updatedAt: new Date().toISOString(),
      };
      await context.orchestration.apply({
        type: "create_run",
        runId,
        workspaceId,
        coordinatorThreadId: threadId,
        title,
        objective,
        checkpoint,
        initialPrompt: coordinatorPrompt(objective, checkpoint.acceptanceCriteria),
      });
      return { runId, started: true };
    });

    for (const [actionId, command] of [
      ["pause-run", "pause"],
      ["extend-run", "extend"],
      ["accept-completion", "accept_completion"],
      ["close-incomplete", "close_incomplete"],
    ] as const) {
      context.actions.register(actionId, async ({ input }) => {
        const target = runInput(input);
        await context.orchestration.apply({
          type: "human_command",
          ...target,
          command,
        });
        return { updated: true };
      });
    }

    context.actions.register("resume-run", async ({ input }) => {
      const target = runInput(input);
      const run = (await context.orchestration.list()).find(
        (candidate) => candidate.id === target.runId,
      );
      if (!run) throw new Error("Mission run no longer exists");
      const checkpoint = checkpointOf(run);
      const hasUnresolvedOperation = run.operations.some(
        (operation) =>
          !["settled", "rejected", "cancelled"].includes(operation.status),
      );
      await context.orchestration.apply({
        type: "human_command",
        ...target,
        command: "resume",
        ...(!run.awaitingWorkers && !hasUnresolvedOperation
          ? {
              operationId: crypto.randomUUID(),
              resumePrompt: continuationPrompt(
                checkpoint.nextAction ??
                  checkpoint.humanQuestion ??
                  "Reassess the Mission after the human resumed it and choose the next bounded action.",
              ),
            }
          : {}),
      });
      return { updated: true };
    });

    context.tools.register("draft-mission", async ({ input, threadId, workspaceId }) => {
      if (!threadId || !workspaceId) {
        throw new Error(
          "this task cannot be securely bound to a Mission draft; use the Missions panel",
        );
      }
      const value = record(input);
      const objective = requiredString(value.objective, "objective", 12_000);
      const title =
        typeof value.title === "string" && value.title.trim()
          ? requiredString(value.title, "title", 120)
          : objective.slice(0, 80);
      const acceptanceCriteria = stringList(
        value.acceptanceCriteria,
        "acceptanceCriteria",
        12,
      );
      const drafts = await context.storage.get<MissionDraft[]>(DRAFTS_KEY, []);
      const draft: MissionDraft = {
        id: crypto.randomUUID(),
        workspaceId,
        threadId,
        title,
        objective,
        acceptanceCriteria,
        createdAt: new Date().toISOString(),
      };
      const next = [
        ...drafts.filter(
          (candidate) =>
            candidate.workspaceId !== workspaceId || candidate.threadId !== threadId,
        ),
        draft,
      ].slice(-MAX_DRAFTS);
      await context.storage.set(DRAFTS_KEY, next);
      const runs = await context.orchestration.list();
      const threads = await context.threads.list();
      await context.views.publish({
        viewId: PANEL_VIEW,
        value: panel(runs, next, threads, "A human must start this draft before automatic work begins."),
      });
      return { draftId: draft.id, status: "awaiting_human_start" };
    });

    context.tools.register("mission-status", async ({ threadId, workspaceId }) => {
      if (!threadId || !workspaceId) {
        throw new Error("this tool call is not bound to an eligible task");
      }
      const run = (await context.orchestration.list()).find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.coordinatorThreadId === threadId &&
          candidate.gate !== "closed",
      );
      if (!run) return { active: false };
      return {
        active: true,
        runId: run.id,
        gate: run.gate,
        status: statusLabel(run),
        objective: run.objective,
        deadlineAt: run.deadlineAt,
        automaticTurnsStarted: run.automaticTurnsStarted,
        maxAutomaticTurns: run.maxAutomaticTurns,
        maxWorkers: run.maxWorkers,
        workers: run.workers.map((worker) => ({
          id: worker.id,
          provider: worker.provider,
          status: worker.status,
          threadId: worker.threadId,
          report: worker.report,
          message: worker.message,
        })),
        checkpoint: checkpointOf(run),
      };
    });

    context.tools.register(
      "mission-delegate",
      async ({ input, threadId, workspaceId }) => {
        if (!threadId || !workspaceId) {
          throw new Error(
            "this delegation is not bound to an eligible coordinator task",
          );
        }
        const run = (await context.orchestration.list()).find(
          (candidate) =>
            candidate.workspaceId === workspaceId &&
            candidate.coordinatorThreadId === threadId &&
            candidate.gate === "open",
        );
        if (!run) {
          throw new Error("this task does not coordinate an open Mission");
        }
        if (run.automaticTurnsStarted >= run.maxAutomaticTurns) {
          throw new Error(
            "no automatic coordinator turn remains to review worker reports",
          );
        }
        const value = record(input);
        const assignment = requiredString(
          value.assignment,
          "assignment",
          12_000,
        );
        const workerId = crypto.randomUUID();
        await context.orchestration.apply({
          type: "delegate_worker",
          runId: run.id,
          expectedPolicyRevision: run.policyRevision,
          workerId,
          provider: "codex",
          assignment,
        });
        return {
          delegated: true,
          workerId,
          remainingWorkerSlots: Math.max(
            0,
            run.maxWorkers - run.workers.length - 1,
          ),
        };
      },
    );

    context.tools.register("mission-checkpoint", async ({ input, threadId, workspaceId }) => {
      if (!threadId || !workspaceId) {
        throw new Error("this checkpoint is not bound to an eligible coordinator task");
      }
      const runs = await context.orchestration.list();
      const run = runs.find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.coordinatorThreadId === threadId &&
          candidate.gate !== "closed",
      );
      if (!run) throw new Error("this task does not coordinate an open Mission");
      const value = record(input);
      const disposition = requiredString(value.disposition, "disposition", 40);
      if (
        disposition !== "continue_self" &&
        disposition !== "awaiting_workers" &&
        disposition !== "needs_human" &&
        disposition !== "proposing_completion"
      ) {
        throw new Error("unsupported Mission disposition");
      }
      const summary = requiredString(value.summary, "summary", 4000);
      const nextAction =
        typeof value.nextAction === "string" && value.nextAction.trim()
          ? requiredString(value.nextAction, "nextAction", 2000)
          : undefined;
      const checkpoint: MissionCheckpoint = {
        ...checkpointOf(run),
        disposition,
        summary,
        ...(nextAction ? { nextAction } : {}),
        evidence: stringList(value.evidence, "evidence", 20),
        limitations: stringList(value.limitations, "limitations", 12),
        ...(typeof value.humanQuestion === "string" && value.humanQuestion.trim()
          ? {
              humanQuestion: requiredString(
                value.humanQuestion,
                "humanQuestion",
                1000,
              ),
            }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      if (disposition === "continue_self") {
        if (!nextAction) throw new Error("continue_self requires nextAction");
        const progressFingerprint = requiredString(
          value.progressFingerprint,
          "progressFingerprint",
          256,
        );
        await context.orchestration.apply({
          type: "request_continuation",
          runId: run.id,
          expectedPolicyRevision: run.policyRevision,
          operationId: crypto.randomUUID(),
          checkpoint,
          progressFingerprint,
          prompt: continuationPrompt(nextAction),
        });
      } else if (disposition === "awaiting_workers") {
        if (
          !run.workers.some(
            (worker) =>
              ![
                "succeeded",
                "failed",
                "outcome_unknown",
                "cancelled",
              ].includes(worker.status),
          )
        ) {
          throw new Error("awaiting_workers requires an active delegated worker");
        }
        await context.orchestration.apply({
          type: "await_workers",
          runId: run.id,
          expectedPolicyRevision: run.policyRevision,
          checkpoint,
        });
      } else if (disposition === "needs_human") {
        await context.orchestration.apply({
          type: "pause_for_human",
          runId: run.id,
          expectedPolicyRevision: run.policyRevision,
          checkpoint,
          reason:
            checkpoint.humanQuestion ??
            "The coordinator needs a human decision before continuing",
        });
      } else {
        if (checkpoint.evidence.length === 0) {
          throw new Error("proposing_completion requires concrete evidence");
        }
        await context.orchestration.apply({
          type: "propose_completion",
          runId: run.id,
          expectedPolicyRevision: run.policyRevision,
          checkpoint,
        });
      }
      return { recorded: true, disposition };
    });

    for (const event of [
      "thread.updated",
      "turn.start",
      "turn.ended",
      "orchestration.updated",
    ] as const) {
      context.events.on(event, async () => publish(context));
    }
  },
});
