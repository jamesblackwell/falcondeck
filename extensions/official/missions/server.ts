import {
  defineExtension,
  type ExtensionOwnedAutomationSummary,
  type ExtensionContext,
  type ExtensionThreadSummary,
} from "@falcondeck/extension-sdk";

import type {
  Mission,
  MissionPanelEntry,
  MissionPanelState,
  MissionStatus,
  MissionThreadLink,
  MissionThreadRole,
  MissionUpdate,
  MissionUpdateKind,
} from "./model";

const PANEL_VIEW = "missions-panel";
const MISSIONS_KEY = "missions";
const MAX_MISSIONS = 20;
const MAX_TOTAL_UPDATES = 300;
const MAX_PANEL_MISSIONS = 8;
const AGENT_STATUSES = new Set<MissionStatus>([
  "active",
  "waiting",
  "needs_human",
  "review",
  "paused",
]);
const HUMAN_STATUSES = new Set<MissionStatus>([
  "active",
  "waiting",
  "needs_human",
  "review",
  "paused",
  "completed",
  "cancelled",
]);
const UPDATE_KINDS = new Set<MissionUpdateKind>([
  "comment",
  "evidence",
  "question",
  "status",
]);
const THREAD_ROLES = new Set<MissionThreadRole>(["source", "work", "review"]);
const MISSION_STATUSES = new Set<MissionStatus>([
  "active",
  "waiting",
  "needs_human",
  "review",
  "paused",
  "completed",
  "cancelled",
]);
const UPDATE_ACTORS = new Set(["human", "agent", "system"]);

type MissionStore = { schemaVersion: 2; missions: Mission[] };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("input must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if ([...normalized].length > max) {
    throw new Error(`${label} must be at most ${max} characters`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, label, max);
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error(`${label} must contain between 1 and 8 strings`);
  }
  return value.map((item, index) =>
    requiredString(item, `${label}[${index}]`, 300),
  );
}

function isoDeadline(value: unknown): string | undefined {
  const raw = optionalString(value, "deadline", 64);
  if (!raw) return undefined;
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) {
    throw new Error("deadline must be a valid date and time");
  }
  return instant.toISOString();
}

function compact(value: string, max: number): string {
  const characters = [...value];
  return characters.length > max
    ? `${characters.slice(0, max).join("").trimEnd()}…`
    : value;
}

function formatCheckInInterval(seconds: number): string {
  const units = [
    [7 * 24 * 60 * 60, "week"],
    [24 * 60 * 60, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ] as const;
  for (const [unitSeconds, label] of units) {
    if (seconds % unitSeconds === 0) {
      const amount = seconds / unitSeconds;
      return `every ${amount} ${label}${amount === 1 ? "" : "s"}`;
    }
  }
  return `every ${seconds} seconds`;
}

function isMission(value: unknown): value is Mission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mission = value as Partial<Mission>;
  return (
    typeof mission.id === "string" &&
    typeof mission.title === "string" &&
    typeof mission.brief === "string" &&
    Array.isArray(mission.successCriteria) &&
    mission.successCriteria.every((item) => typeof item === "string") &&
    MISSION_STATUSES.has(mission.status as MissionStatus) &&
    (mission.deadline === undefined || typeof mission.deadline === "string") &&
    Array.isArray(mission.threads) &&
    mission.threads.every(
      (thread) =>
        thread &&
        typeof thread.workspaceId === "string" &&
        typeof thread.threadId === "string" &&
        THREAD_ROLES.has(thread.role) &&
        typeof thread.linkedAt === "string",
    ) &&
    Array.isArray(mission.updates) &&
    mission.updates.every(
      (update) =>
        update &&
        typeof update.id === "string" &&
        UPDATE_ACTORS.has(update.actor) &&
        UPDATE_KINDS.has(update.kind) &&
        typeof update.body === "string" &&
        (update.threadId === undefined ||
          typeof update.threadId === "string") &&
        typeof update.createdAt === "string",
    ) &&
    typeof mission.createdAt === "string" &&
    typeof mission.updatedAt === "string"
  );
}

async function loadStore(context: ExtensionContext): Promise<MissionStore> {
  const stored = await context.storage.get<unknown>(MISSIONS_KEY, null);
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const candidate = stored as Partial<MissionStore>;
    if (
      candidate.schemaVersion === 2 &&
      Array.isArray(candidate.missions) &&
      candidate.missions.every(isMission)
    ) {
      return { schemaVersion: 2, missions: candidate.missions };
    }
    throw new Error("stored Mission data is malformed");
  }

  const empty = { schemaVersion: 2 as const, missions: [] };
  await context.storage.set(MISSIONS_KEY, empty);
  return empty;
}

async function saveStore(
  context: ExtensionContext,
  store: MissionStore,
): Promise<void> {
  const totalUpdates = store.missions.reduce(
    (total, mission) => total + mission.updates.length,
    0,
  );
  if (store.missions.length > MAX_MISSIONS) {
    throw new Error(`Missions is limited to ${MAX_MISSIONS} stored projects`);
  }
  if (totalUpdates > MAX_TOTAL_UPDATES) {
    throw new Error(
      `Missions has reached its ${MAX_TOTAL_UPDATES}-update storage limit; close or export older Missions first`,
    );
  }
  await context.storage.set(MISSIONS_KEY, store);
}

function threadKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}:${threadId}`;
}

function attentionRank(mission: Mission): number {
  if (mission.status === "needs_human") return 0;
  if (
    mission.deadline &&
    new Date(mission.deadline).getTime() < Date.now() &&
    !["completed", "cancelled"].includes(mission.status)
  ) {
    return 1;
  }
  if (mission.status === "review") return 2;
  if (["active", "waiting"].includes(mission.status)) return 3;
  if (mission.status === "paused") return 4;
  return 5;
}

function panelState(
  missions: Mission[],
  threads: ExtensionThreadSummary[],
  automations: ExtensionOwnedAutomationSummary[],
): MissionPanelState {
  const summaries = new Map(
    threads.map((thread) => [threadKey(thread.workspaceId, thread.id), thread]),
  );
  const entries: MissionPanelEntry[] = [...missions]
    .sort(
      (left, right) =>
        attentionRank(left) - attentionRank(right) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, MAX_PANEL_MISSIONS)
    .map((mission) => ({
      ...mission,
      brief: compact(mission.brief, 240),
      successCriteria: mission.successCriteria
        .slice(0, 3)
        .map((criterion) => compact(criterion, 120)),
      updates: mission.updates
        .slice(-2)
        .map((update) => ({ ...update, body: compact(update.body, 160) })),
      threads: mission.threads.slice(0, 4).map((link) => {
        const summary = summaries.get(
          threadKey(link.workspaceId, link.threadId),
        );
        return {
          ...link,
          title: summary?.title ?? "Unavailable task",
          provider: summary?.provider ?? "unknown",
          status: summary?.status ?? "unavailable",
        };
      }),
      automations: automations
        .filter((automation) => automation.resourceId === mission.id)
        .map(({ resourceId: _, ...automation }) => automation),
    }));
  return {
    schemaVersion: 2,
    missions: entries,
    updatedAt: new Date().toISOString(),
  };
}

async function publish(
  context: ExtensionContext,
  store: MissionStore,
): Promise<void> {
  const threads = await context.threads.list();
  const automations = await context.automations.list();
  await context.views.publish({
    viewId: PANEL_VIEW,
    value: panelState(store.missions, threads, automations),
  });
}

function missionById(store: MissionStore, missionId: string): Mission {
  const mission = store.missions.find(
    (candidate) => candidate.id === missionId,
  );
  if (!mission) throw new Error("Mission was not found");
  return mission;
}

function missionForAgent(
  store: MissionStore,
  missionId: unknown,
  workspaceId: string,
  threadId: string,
  automationOwnerResourceId?: string,
): Mission {
  const linked = store.missions.filter((mission) =>
    mission.threads.some(
      (thread) =>
        thread.workspaceId === workspaceId && thread.threadId === threadId,
    ),
  );
  if (typeof missionId === "string") {
    const mission = missionById(store, missionId);
    if (
      !linked.some((candidate) => candidate.id === mission.id) &&
      automationOwnerResourceId !== mission.id
    ) {
      throw new Error("this task is not linked to that Mission");
    }
    return mission;
  }
  if (automationOwnerResourceId) {
    return missionById(store, automationOwnerResourceId);
  }
  if (linked.length === 0)
    throw new Error("this task is not linked to a Mission");
  if (linked.length > 1)
    throw new Error(
      "missionId is required because this task has multiple Missions",
    );
  return linked[0]!;
}

function linkAutomationTask(
  mission: Mission,
  workspaceId: string,
  threadId: string,
): boolean {
  if (
    mission.threads.some(
      (link) => link.workspaceId === workspaceId && link.threadId === threadId,
    )
  ) {
    return false;
  }
  const now = new Date().toISOString();
  mission.threads.push({
    workspaceId,
    threadId,
    role: "review",
    linkedAt: now,
  });
  addUpdate(
    mission,
    {
      actor: "system",
      kind: "status",
      body: "Linked the task created by this Mission's review Automation.",
      threadId,
    },
    now,
  );
  return true;
}

function reviewInstruction(missionId: string): string {
  return [
    `Review FalconDeck Mission ${missionId}.`,
    `First call read-mission with missionId ${missionId}; treat that durable brief, its success criteria, updates, and linked tasks as authoritative.`,
    "Decide the cheapest useful next step. Reuse a healthy linked task where practical; create or delegate to another task only for clean context, a distinct harness capability, independent work, or independent review.",
    "Perform one bounded check-in only. Never sleep, poll, or build an interval loop inside this task; FalconDeck's Automation supplies the recurrence.",
    "If the Mission deadline has passed or its success criteria are satisfied, post final evidence, set the Mission to review, and stop. Setting review pauses future check-ins until the human decides what comes next.",
    "Use native Goals for bounded execution inside a task when helpful. Do not spend tokens while waiting for an external condition.",
    "Before finishing, call update-mission with meaningful evidence, a decision, a concrete human question, or the appropriate non-terminal status. Never mark the Mission completed or cancelled.",
  ].join("\n\n");
}

function addUpdate(
  mission: Mission,
  update: Omit<MissionUpdate, "id" | "createdAt">,
  now = new Date().toISOString(),
): void {
  mission.updates.push({ id: crypto.randomUUID(), ...update, createdAt: now });
  mission.updatedAt = now;
}

function createMissionInput(input: unknown) {
  const args = record(input);
  const checkInSeconds = Number(args.checkInSeconds);
  if (!Number.isSafeInteger(checkInSeconds) || checkInSeconds < 60) {
    throw new Error("checkInSeconds must be a whole number of at least 60");
  }
  return {
    title: requiredString(args.title, "title", 120),
    brief: requiredString(args.brief, "brief", 4_000),
    successCriteria: stringList(args.successCriteria, "successCriteria"),
    deadline: isoDeadline(args.deadline),
    checkInSeconds,
  };
}

export default defineExtension({
  async activate(context) {
    context.events.on("automations.updated", async () => {
      const store = await loadStore(context);
      await publish(context, store);
    });

    context.actions.register("refresh-missions", async () => {
      const store = await loadStore(context);
      await publish(context, store);
      return { refreshed: true };
    });

    context.actions.register("add-mission-update", async ({ input }) => {
      const args = record(input);
      const store = await loadStore(context);
      const mission = missionById(
        store,
        requiredString(args.missionId, "missionId", 128),
      );
      if (
        args.runNow === true &&
        ["review", "paused", "completed", "cancelled"].includes(mission.status)
      ) {
        throw new Error("reactivate the Mission before requesting a review");
      }
      addUpdate(mission, {
        actor: "human",
        kind: "comment",
        body: requiredString(args.body, "body", 1_000),
      });
      await saveStore(context, store);
      await publish(context, store);
      if (args.runNow === true) {
        const automation = (await context.automations.list()).find(
          (candidate) => candidate.resourceId === mission.id,
        );
        if (automation) {
          await context.automations.apply({
            type: "run_now",
            automationId: automation.id,
            idempotencyKey: `mission-message-${crypto.randomUUID()}`,
          });
        }
      }
      return { missionId: mission.id, posted: true };
    });

    context.actions.register("set-mission-status", async ({ input }) => {
      const args = record(input);
      const store = await loadStore(context);
      const mission = missionById(
        store,
        requiredString(args.missionId, "missionId", 128),
      );
      const status = requiredString(args.status, "status", 32) as MissionStatus;
      if (!HUMAN_STATUSES.has(status))
        throw new Error("unsupported Mission status");
      if (["completed", "cancelled"].includes(mission.status)) {
        throw new Error("a completed or cancelled Mission is terminal");
      }
      mission.status = status;
      addUpdate(mission, {
        actor: "human",
        kind: "status",
        body: `Mission marked ${status.replaceAll("_", " ")}.`,
      });
      await saveStore(context, store);
      await publish(context, store);
      if (["review", "paused", "completed", "cancelled"].includes(status)) {
        await context.automations.apply({
          type: "pause_resource",
          resourceId: mission.id,
        });
      }
      return { missionId: mission.id, status };
    });

    context.actions.register("schedule-mission-review", async ({ input }) => {
      const args = record(input);
      const store = await loadStore(context);
      const mission = missionById(
        store,
        requiredString(args.missionId, "missionId", 128),
      );
      if (
        ["review", "paused", "completed", "cancelled"].includes(mission.status)
      ) {
        throw new Error("reactivate the Mission before scheduling check-ins");
      }
      const checkInSeconds = Number(args.checkInSeconds);
      if (!Number.isSafeInteger(checkInSeconds) || checkInSeconds < 60) {
        throw new Error("checkInSeconds must be a whole number of at least 60");
      }
      const existing = (await context.automations.list()).find(
        (automation) => automation.resourceId === mission.id,
      );
      if (existing)
        throw new Error("this Mission already has a review Automation");
      const source =
        mission.threads.find((thread) => thread.role === "source") ??
        mission.threads[0];
      if (!source) throw new Error("the Mission has no linked source task");
      await context.automations.apply({
        type: "create_from_thread",
        resourceId: mission.id,
        sourceWorkspaceId: source.workspaceId,
        sourceThreadId: source.threadId,
        idempotencyKey: `mission-review-${mission.id}`,
        name: `${mission.title} — review`,
        description: "Periodic review owned by FalconDeck Missions.",
        trigger: {
          kind: "interval",
          every_seconds: checkInSeconds,
          anchor_at: new Date().toISOString(),
        },
        task: { kind: "prompt", instruction: reviewInstruction(mission.id) },
        runImmediately: args.runImmediately === true,
        concurrencyPolicy: "queue_one",
        misfirePolicy: "run_once",
      });
      return { missionId: mission.id, scheduled: true };
    });

    context.actions.register(
      "control-mission-automation",
      async ({ input }) => {
        const args = record(input);
        const missionId = requiredString(args.missionId, "missionId", 128);
        const operation = requiredString(args.operation, "operation", 16);
        const mission = missionById(await loadStore(context), missionId);
        if (
          operation === "resume" &&
          ["review", "paused", "completed", "cancelled"].includes(
            mission.status,
          )
        ) {
          throw new Error("reactivate the Mission before resuming its reviews");
        }
        const automation = (await context.automations.list()).find(
          (candidate) => candidate.resourceId === missionId,
        );
        if (!automation)
          throw new Error("the Mission has no review Automation");
        if (
          operation === "pause" ||
          operation === "resume" ||
          operation === "delete"
        ) {
          await context.automations.apply({
            type: operation,
            automationId: automation.id,
            expectedRevision: automation.revision,
          });
        } else {
          throw new Error("unsupported Automation operation");
        }
        return { missionId, operation };
      },
    );

    context.actions.register("run-mission-review", async ({ input }) => {
      const args = record(input);
      const missionId = requiredString(args.missionId, "missionId", 128);
      const mission = missionById(await loadStore(context), missionId);
      if (
        ["review", "paused", "completed", "cancelled"].includes(mission.status)
      ) {
        throw new Error("reactivate the Mission before requesting a review");
      }
      const automation = (await context.automations.list()).find(
        (candidate) => candidate.resourceId === missionId,
      );
      if (!automation) throw new Error("the Mission has no review Automation");
      await context.automations.apply({
        type: "run_now",
        automationId: automation.id,
        idempotencyKey: `mission-review-now-${crypto.randomUUID()}`,
      });
      return { missionId, queued: true };
    });

    context.tools.register(
      "create-mission",
      async ({ input, threadId, workspaceId }) => {
        if (!threadId || !workspaceId) {
          throw new Error("FalconDeck could not verify the calling task");
        }
        const store = await loadStore(context);
        if (store.missions.length >= MAX_MISSIONS) {
          throw new Error(
            `Missions is limited to ${MAX_MISSIONS} stored projects`,
          );
        }
        const args = createMissionInput(input);
        const now = new Date().toISOString();
        const mission: Mission = {
          id: crypto.randomUUID(),
          title: args.title,
          brief: args.brief,
          successCriteria: args.successCriteria,
          status: "active",
          ...(args.deadline ? { deadline: args.deadline } : {}),
          threads: [{ workspaceId, threadId, role: "source", linkedAt: now }],
          updates: [
            {
              id: crypto.randomUUID(),
              actor: "agent",
              kind: "status",
              body: `Mission started. The first agent check-in was queued, with future check-ins ${formatCheckInInterval(args.checkInSeconds)}.`,
              threadId,
              createdAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        };
        store.missions.unshift(mission);
        await saveStore(context, store);
        await publish(context, store);
        await context.automations.apply({
          type: "create_from_thread",
          resourceId: mission.id,
          sourceWorkspaceId: workspaceId,
          sourceThreadId: threadId,
          idempotencyKey: `mission-start-${mission.id}`,
          name: `${mission.title} — review`,
          description: "Periodic review owned by FalconDeck Missions.",
          trigger: {
            kind: "interval",
            every_seconds: args.checkInSeconds,
            anchor_at: now,
          },
          task: { kind: "prompt", instruction: reviewInstruction(mission.id) },
          runImmediately: true,
          concurrencyPolicy: "queue_one",
          misfirePolicy: "run_once",
        });
        return {
          missionId: mission.id,
          status: mission.status,
          firstCheckInQueued: true,
          checkInSeconds: args.checkInSeconds,
        };
      },
    );

    context.tools.register(
      "read-mission",
      async ({ input, threadId, workspaceId, automationOwnerResourceId }) => {
        if (!threadId || !workspaceId) {
          throw new Error("FalconDeck could not verify the calling task");
        }
        const args = record(input);
        const store = await loadStore(context);
        const mission = missionForAgent(
          store,
          args.missionId,
          workspaceId,
          threadId,
          automationOwnerResourceId,
        );
        if (
          automationOwnerResourceId === mission.id &&
          linkAutomationTask(mission, workspaceId, threadId)
        ) {
          await saveStore(context, store);
          await publish(context, store);
        }
        return mission;
      },
    );

    context.tools.register(
      "update-mission",
      async ({ input, threadId, workspaceId, automationOwnerResourceId }) => {
        if (!threadId || !workspaceId) {
          throw new Error("FalconDeck could not verify the calling task");
        }
        const args = record(input);
        const store = await loadStore(context);
        const mission = missionForAgent(
          store,
          args.missionId,
          workspaceId,
          threadId,
          automationOwnerResourceId,
        );
        if (automationOwnerResourceId === mission.id) {
          linkAutomationTask(mission, workspaceId, threadId);
        }
        if (["completed", "cancelled"].includes(mission.status)) {
          throw new Error("a completed or cancelled Mission is terminal");
        }
        const operation = requiredString(args.operation, "operation", 32);

        if (operation === "add_update") {
          const kind = requiredString(
            args.kind,
            "kind",
            32,
          ) as MissionUpdateKind;
          if (!UPDATE_KINDS.has(kind))
            throw new Error("unsupported Mission update kind");
          addUpdate(mission, {
            actor: "agent",
            kind,
            body: requiredString(args.body, "body", 1_000),
            threadId,
          });
        } else if (operation === "set_status") {
          const status = requiredString(
            args.status,
            "status",
            32,
          ) as MissionStatus;
          if (!AGENT_STATUSES.has(status)) {
            throw new Error("agents cannot complete or cancel a Mission");
          }
          mission.status = status;
          addUpdate(mission, {
            actor: "agent",
            kind: "status",
            body:
              optionalString(args.body, "body", 1_000) ??
              `Mission marked ${status.replaceAll("_", " ")}.`,
            threadId,
          });
          if (status === "review" || status === "paused") {
            await context.automations.apply({
              type: "pause_resource",
              resourceId: mission.id,
            });
          }
        } else if (operation === "link_thread") {
          const targetWorkspaceId =
            optionalString(args.workspaceId, "workspaceId", 256) ?? workspaceId;
          const targetThreadId = requiredString(args.threadId, "threadId", 256);
          const role = (optionalString(args.role, "role", 32) ??
            "work") as MissionThreadRole;
          if (!THREAD_ROLES.has(role))
            throw new Error("unsupported Mission task role");
          const threads = await context.threads.list();
          if (
            !threads.some(
              (thread) =>
                thread.workspaceId === targetWorkspaceId &&
                thread.id === targetThreadId,
            )
          ) {
            throw new Error("the task to link was not found in FalconDeck");
          }
          if (
            !mission.threads.some(
              (link) =>
                link.workspaceId === targetWorkspaceId &&
                link.threadId === targetThreadId,
            )
          ) {
            const link: MissionThreadLink = {
              workspaceId: targetWorkspaceId,
              threadId: targetThreadId,
              role,
              linkedAt: new Date().toISOString(),
            };
            mission.threads.push(link);
            addUpdate(mission, {
              actor: "agent",
              kind: "status",
              body: `Linked a ${role} task to the Mission.`,
              threadId,
            });
          }
        } else {
          throw new Error("unsupported Mission update operation");
        }

        await saveStore(context, store);
        await publish(context, store);
        return {
          missionId: mission.id,
          status: mission.status,
          updatedAt: mission.updatedAt,
        };
      },
    );
  },
});
