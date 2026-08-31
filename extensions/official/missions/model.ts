export type MissionDraft = {
  id: string;
  workspaceId: string;
  threadId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  createdAt: string;
};

export type MissionCheckpoint = {
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

export type MissionPanelWorker = {
  id: string;
  provider: string;
  status: string;
  threadId?: string;
  message?: string;
};

export type MissionPanelRun = {
  id: string;
  workspaceId: string;
  coordinatorThreadId: string;
  title: string;
  objective: string;
  gate: "open" | "paused" | "closed";
  outcome?: string;
  pauseReason?: string;
  policyRevision: number;
  automaticTurnsStarted: number;
  maxAutomaticTurns: number;
  maxWorkers: number;
  deadlineAt: string;
  completionProposed: boolean;
  status: string;
  checkpoint: Pick<
    MissionCheckpoint,
    | "summary"
    | "nextAction"
    | "evidence"
    | "limitations"
    | "humanQuestion"
  >;
  workers: MissionPanelWorker[];
  hasUnknownOutcome: boolean;
  coordinatorSettling: boolean;
};

export type MissionPanelDraft = Pick<
  MissionDraft,
  "id" | "workspaceId" | "threadId" | "title" | "objective" | "createdAt"
> & {
  acceptanceCriteriaCount: number;
};

export type MissionPanelCandidate = {
  id: string;
  workspaceId: string;
  title: string;
  provider: string;
};

export type MissionPanelState = {
  schemaVersion: 1;
  runs: MissionPanelRun[];
  drafts: MissionPanelDraft[];
  candidates: MissionPanelCandidate[];
  notice?: string;
  updatedAt: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function parseMissionPanelState(value: unknown): MissionPanelState | null {
  const root = record(value);
  if (
    root?.schemaVersion !== 1 ||
    !Array.isArray(root.runs) ||
    !Array.isArray(root.drafts) ||
    !Array.isArray(root.candidates) ||
    typeof root.updatedAt !== "string"
  ) {
    return null;
  }

  const runs = root.runs.flatMap((value): MissionPanelRun[] => {
    const run = record(value);
    const checkpoint = record(run?.checkpoint);
    if (
      !run ||
      typeof run.id !== "string" ||
      typeof run.workspaceId !== "string" ||
      typeof run.coordinatorThreadId !== "string" ||
      typeof run.title !== "string" ||
      typeof run.objective !== "string" ||
      (run.gate !== "open" && run.gate !== "paused" && run.gate !== "closed") ||
      typeof run.policyRevision !== "number" ||
      typeof run.automaticTurnsStarted !== "number" ||
      typeof run.maxAutomaticTurns !== "number" ||
      typeof run.maxWorkers !== "number" ||
      typeof run.deadlineAt !== "string" ||
      typeof run.completionProposed !== "boolean" ||
      typeof run.status !== "string" ||
      typeof run.hasUnknownOutcome !== "boolean" ||
      typeof run.coordinatorSettling !== "boolean" ||
      !checkpoint ||
      !Array.isArray(run.workers)
    ) {
      return [];
    }
    const workers = run.workers.flatMap((value): MissionPanelWorker[] => {
      const worker = record(value);
      return worker &&
        typeof worker.id === "string" &&
        typeof worker.provider === "string" &&
        typeof worker.status === "string"
        ? [
            {
              id: worker.id,
              provider: worker.provider,
              status: worker.status,
              ...(typeof worker.threadId === "string"
                ? { threadId: worker.threadId }
                : {}),
              ...(typeof worker.message === "string"
                ? { message: worker.message }
                : {}),
            },
          ]
        : [];
    });
    return [
      {
        id: run.id,
        workspaceId: run.workspaceId,
        coordinatorThreadId: run.coordinatorThreadId,
        title: run.title,
        objective: run.objective,
        gate: run.gate,
        ...(typeof run.outcome === "string" ? { outcome: run.outcome } : {}),
        ...(typeof run.pauseReason === "string"
          ? { pauseReason: run.pauseReason }
          : {}),
        policyRevision: run.policyRevision,
        automaticTurnsStarted: run.automaticTurnsStarted,
        maxAutomaticTurns: run.maxAutomaticTurns,
        maxWorkers: run.maxWorkers,
        deadlineAt: run.deadlineAt,
        completionProposed: run.completionProposed,
        status: run.status,
        checkpoint: {
          summary: typeof checkpoint.summary === "string" ? checkpoint.summary : "",
          ...(typeof checkpoint.nextAction === "string"
            ? { nextAction: checkpoint.nextAction }
            : {}),
          evidence: strings(checkpoint.evidence),
          limitations: strings(checkpoint.limitations),
          ...(typeof checkpoint.humanQuestion === "string"
            ? { humanQuestion: checkpoint.humanQuestion }
            : {}),
        },
        workers,
        hasUnknownOutcome: run.hasUnknownOutcome,
        coordinatorSettling: run.coordinatorSettling,
      },
    ];
  });

  const drafts = root.drafts.flatMap((value): MissionPanelDraft[] => {
    const draft = record(value);
    return draft &&
      typeof draft.id === "string" &&
      typeof draft.workspaceId === "string" &&
      typeof draft.threadId === "string" &&
      typeof draft.title === "string" &&
      typeof draft.objective === "string" &&
      typeof draft.createdAt === "string" &&
      typeof draft.acceptanceCriteriaCount === "number"
      ? [
          {
            id: draft.id,
            workspaceId: draft.workspaceId,
            threadId: draft.threadId,
            title: draft.title,
            objective: draft.objective,
            createdAt: draft.createdAt,
            acceptanceCriteriaCount: draft.acceptanceCriteriaCount,
          },
        ]
      : [];
  });

  const candidates = root.candidates.flatMap(
    (value): MissionPanelCandidate[] => {
      const candidate = record(value);
      return candidate &&
        typeof candidate.id === "string" &&
        typeof candidate.workspaceId === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.provider === "string"
        ? [
            {
              id: candidate.id,
              workspaceId: candidate.workspaceId,
              title: candidate.title,
              provider: candidate.provider,
            },
          ]
        : [];
    },
  );

  if (
    runs.length !== root.runs.length ||
    drafts.length !== root.drafts.length ||
    candidates.length !== root.candidates.length
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    runs,
    drafts,
    candidates,
    ...(typeof root.notice === "string" ? { notice: root.notice } : {}),
    updatedAt: root.updatedAt,
  };
}
