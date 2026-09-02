export type MissionStatus =
  | "active"
  | "waiting"
  | "needs_human"
  | "review"
  | "paused"
  | "completed"
  | "cancelled";

export type MissionThreadRole = "source" | "work" | "review";
export type MissionUpdateActor = "human" | "agent" | "system";
export type MissionUpdateKind = "comment" | "evidence" | "question" | "status";

export type MissionThreadLink = {
  workspaceId: string;
  threadId: string;
  role: MissionThreadRole;
  linkedAt: string;
};

export type MissionUpdate = {
  id: string;
  actor: MissionUpdateActor;
  kind: MissionUpdateKind;
  body: string;
  threadId?: string;
  createdAt: string;
};

export type Mission = {
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

export type MissionPanelThread = MissionThreadLink & {
  title: string;
  provider: string;
  status: string;
};

export type MissionPanelAutomation = {
  id: string;
  revision: number;
  name: string;
  state: "enabled" | "paused" | "completed" | "failed";
  provider: string;
  resolvedSchedule: string;
  nextRunAt?: string;
  latestOutcome?: {
    status: string;
    finishedAt: string;
    preview?: string;
  };
};

export type MissionPanelEntry = Omit<Mission, "threads"> & {
  threads: MissionPanelThread[];
  automations: MissionPanelAutomation[];
};

export type MissionPanelState = {
  schemaVersion: 2;
  missions: MissionPanelEntry[];
  updatedAt: string;
};

const MISSION_STATUSES = new Set<MissionStatus>([
  "active",
  "waiting",
  "needs_human",
  "review",
  "paused",
  "completed",
  "cancelled",
]);
const THREAD_ROLES = new Set<MissionThreadRole>(["source", "work", "review"]);
const UPDATE_ACTORS = new Set<MissionUpdateActor>(["human", "agent", "system"]);
const UPDATE_KINDS = new Set<MissionUpdateKind>([
  "comment",
  "evidence",
  "question",
  "status",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseThread(value: unknown): MissionPanelThread | null {
  const thread = record(value);
  if (
    !thread ||
    typeof thread.workspaceId !== "string" ||
    typeof thread.threadId !== "string" ||
    !THREAD_ROLES.has(thread.role as MissionThreadRole) ||
    typeof thread.linkedAt !== "string" ||
    typeof thread.title !== "string" ||
    typeof thread.provider !== "string" ||
    typeof thread.status !== "string"
  ) {
    return null;
  }
  return {
    workspaceId: thread.workspaceId,
    threadId: thread.threadId,
    role: thread.role as MissionThreadRole,
    linkedAt: thread.linkedAt,
    title: thread.title,
    provider: thread.provider,
    status: thread.status,
  };
}

function parseUpdate(value: unknown): MissionUpdate | null {
  const update = record(value);
  if (
    !update ||
    typeof update.id !== "string" ||
    !UPDATE_ACTORS.has(update.actor as MissionUpdateActor) ||
    !UPDATE_KINDS.has(update.kind as MissionUpdateKind) ||
    typeof update.body !== "string" ||
    typeof update.createdAt !== "string" ||
    (update.threadId !== undefined && typeof update.threadId !== "string")
  ) {
    return null;
  }
  return {
    id: update.id,
    actor: update.actor as MissionUpdateActor,
    kind: update.kind as MissionUpdateKind,
    body: update.body,
    ...(typeof update.threadId === "string"
      ? { threadId: update.threadId }
      : {}),
    createdAt: update.createdAt,
  };
}

function parseAutomation(value: unknown): MissionPanelAutomation | null {
  const automation = record(value);
  if (
    !automation ||
    typeof automation.id !== "string" ||
    typeof automation.revision !== "number" ||
    !Number.isSafeInteger(automation.revision) ||
    automation.revision < 1 ||
    typeof automation.name !== "string" ||
    !["enabled", "paused", "completed", "failed"].includes(
      String(automation.state),
    ) ||
    typeof automation.provider !== "string" ||
    typeof automation.resolvedSchedule !== "string" ||
    (automation.nextRunAt !== undefined &&
      automation.nextRunAt !== null &&
      typeof automation.nextRunAt !== "string")
  ) {
    return null;
  }
  const latest = record(automation.latestOutcome);
  if (
    automation.latestOutcome !== undefined &&
    automation.latestOutcome !== null &&
    (!latest ||
      typeof latest.status !== "string" ||
      typeof latest.finishedAt !== "string" ||
      (latest.preview !== undefined &&
        latest.preview !== null &&
        typeof latest.preview !== "string"))
  ) {
    return null;
  }
  return {
    id: automation.id,
    revision: automation.revision,
    name: automation.name,
    state: automation.state as MissionPanelAutomation["state"],
    provider: automation.provider,
    resolvedSchedule: automation.resolvedSchedule,
    ...(typeof automation.nextRunAt === "string"
      ? { nextRunAt: automation.nextRunAt }
      : {}),
    ...(latest
      ? {
          latestOutcome: {
            status: latest.status as string,
            finishedAt: latest.finishedAt as string,
            ...(typeof latest.preview === "string"
              ? { preview: latest.preview }
              : {}),
          },
        }
      : {}),
  };
}

function parseMission(value: unknown): MissionPanelEntry | null {
  const mission = record(value);
  if (
    !mission ||
    typeof mission.id !== "string" ||
    typeof mission.title !== "string" ||
    typeof mission.brief !== "string" ||
    !Array.isArray(mission.successCriteria) ||
    !mission.successCriteria.every((item) => typeof item === "string") ||
    !MISSION_STATUSES.has(mission.status as MissionStatus) ||
    (mission.deadline !== undefined && typeof mission.deadline !== "string") ||
    !Array.isArray(mission.threads) ||
    !Array.isArray(mission.automations) ||
    !Array.isArray(mission.updates) ||
    typeof mission.createdAt !== "string" ||
    typeof mission.updatedAt !== "string"
  ) {
    return null;
  }
  const threads = mission.threads.map(parseThread);
  const updates = mission.updates.map(parseUpdate);
  const automations = mission.automations.map(parseAutomation);
  if (
    threads.some((item) => item === null) ||
    updates.some((item) => item === null) ||
    automations.some((item) => item === null)
  ) {
    return null;
  }
  return {
    id: mission.id,
    title: mission.title,
    brief: mission.brief,
    successCriteria: mission.successCriteria as string[],
    status: mission.status as MissionStatus,
    ...(typeof mission.deadline === "string"
      ? { deadline: mission.deadline }
      : {}),
    threads: threads as MissionPanelThread[],
    automations: automations as MissionPanelAutomation[],
    updates: updates as MissionUpdate[],
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

export function parseMissionPanelState(
  value: unknown,
): MissionPanelState | null {
  const root = record(value);
  if (
    root?.schemaVersion !== 2 ||
    !Array.isArray(root.missions) ||
    typeof root.updatedAt !== "string"
  ) {
    return null;
  }
  const missions = root.missions.map(parseMission);
  if (missions.some((mission) => mission === null)) return null;
  return {
    schemaVersion: 2,
    missions: missions as MissionPanelEntry[],
    updatedAt: root.updatedAt,
  };
}
