import {
  defineExtension,
  type ExtensionContext,
  type ExtensionViewScope,
} from "@falcondeck/extension-sdk";

type Color =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink";
type StageIcon =
  | "backlog"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled"
  | "custom";
type Stage = {
  id: string;
  label: string;
  color: Color;
  icon: StageIcon;
};
type ThreadStages = Record<string, string>;
type ManageStagesInput =
  | { operation: "read" }
  | { operation: "set_thread_stage"; stageId: string | null }
  | { operation: "create_stage"; label: string; color?: Color };

const STAGES_KEY = "stages";
const THREAD_STAGES_KEY = "threadStages";
const LEGACY_THREAD_COLORS_KEY = "threadColors";
const LEGACY_TAGS_KEY = "tags";
const LEGACY_ASSIGNMENTS_KEY = "assignments";
const MAX_STAGES = 24;
const MAX_LABEL_CHARS = 32;
const COLORS: Color[] = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
];
const ALLOWED_COLORS = new Set<Color>(COLORS);
const STAGE_ICONS = new Set<StageIcon>([
  "backlog",
  "in_progress",
  "in_review",
  "done",
  "canceled",
  "custom",
]);
const DEFAULT_STAGES: Stage[] = [
  { id: "backlog", label: "Backlog", color: "gray", icon: "backlog" },
  {
    id: "in_progress",
    label: "In progress",
    color: "yellow",
    icon: "in_progress",
  },
  { id: "in_review", label: "In review", color: "green", icon: "in_review" },
  { id: "done", label: "Done", color: "orange", icon: "done" },
  { id: "canceled", label: "Canceled", color: "gray", icon: "canceled" },
];

function threadScope(threadId: string): ExtensionViewScope {
  return { kind: "thread", id: threadId };
}

function isStage(value: unknown): value is Stage {
  if (!value || typeof value !== "object") return false;
  const stage = value as Partial<Stage>;
  return (
    typeof stage.id === "string" &&
    stage.id.length > 0 &&
    typeof stage.label === "string" &&
    stage.label.length > 0 &&
    ALLOWED_COLORS.has(stage.color as Color) &&
    STAGE_ICONS.has(stage.icon as StageIcon)
  );
}

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "stage";
}

function uniqueStageId(label: string, existing: Set<string>): string {
  const base = slugify(label);
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function nextStageColor(stages: Stage[]): Color {
  return COLORS[stages.length % COLORS.length]!;
}

async function readStages(context: ExtensionContext): Promise<Stage[]> {
  const current = await context.storage.get<Stage[] | null>(STAGES_KEY, null);
  if (Array.isArray(current)) {
    const stages = current.filter(isStage);
    if (stages.length > 0) return stages;
  }
  await context.storage.set(STAGES_KEY, DEFAULT_STAGES);
  return DEFAULT_STAGES;
}

async function readThreadStages(
  context: ExtensionContext,
): Promise<ThreadStages> {
  const current = await context.storage.get<ThreadStages | null>(
    THREAD_STAGES_KEY,
    null,
  );
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return Object.fromEntries(
      Object.entries(current).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  // Colour labels are not stages. Drop the old Finder-style assignments
  // instead of inventing a mapping that would mislabel existing threads.
  await context.storage.set(THREAD_STAGES_KEY, {});
  await context.storage.delete(LEGACY_THREAD_COLORS_KEY);
  await context.storage.delete(LEGACY_TAGS_KEY);
  await context.storage.delete(LEGACY_ASSIGNMENTS_KEY);
  return {};
}

async function publishStageViews(
  context: ExtensionContext,
  stages: Stage[],
  threadStages: ThreadStages,
  threadId?: string,
): Promise<void> {
  await context.views.publish({
    viewId: "tag-index",
    value: { tags: stages },
  });
  if (!threadId) return;
  await context.views.publish({
    viewId: "thread-tags",
    scope: threadScope(threadId),
    value: {
      tagIds: threadStages[threadId] ? [threadStages[threadId]] : [],
    },
  });
}

export default defineExtension({
  activate(context) {
    context.actions.register<ManageStagesInput>(
      "manage-tags",
      async ({ target, input }) => {
        const stages = await readStages(context);
        const threadStages = await readThreadStages(context);
        const stagesById = new Map(stages.map((stage) => [stage.id, stage]));

        if (input.operation === "set_thread_stage") {
          if (target?.kind !== "thread") {
            throw new Error("set_thread_stage requires a thread target");
          }
          if (input.stageId === null) delete threadStages[target.id];
          else if (stagesById.has(input.stageId)) {
            threadStages[target.id] = input.stageId;
          } else throw new Error("unknown thread stage");
          await context.storage.set(THREAD_STAGES_KEY, threadStages);
          await publishStageViews(context, stages, threadStages, target.id);
        } else if (input.operation === "create_stage") {
          const label = input.label.trim();
          if (!label) throw new Error("stage label is required");
          if (Array.from(label).length > MAX_LABEL_CHARS) {
            throw new Error("stage label is too long");
          }
          if (stages.length >= MAX_STAGES) {
            throw new Error("stage limit reached");
          }
          const color = input.color && ALLOWED_COLORS.has(input.color)
            ? input.color
            : nextStageColor(stages);
          const stage: Stage = {
            id: uniqueStageId(label, new Set(stagesById.keys())),
            label,
            color,
            icon: "custom",
          };
          stages.push(stage);
          if (target?.kind === "thread") {
            threadStages[target.id] = stage.id;
            await context.storage.set(THREAD_STAGES_KEY, threadStages);
          }
          await context.storage.set(STAGES_KEY, stages);
          await publishStageViews(
            context,
            stages,
            threadStages,
            target?.kind === "thread" ? target.id : undefined,
          );
        } else {
          await publishStageViews(
            context,
            stages,
            threadStages,
            target?.kind === "thread" ? target.id : undefined,
          );
        }

        return {
          stages,
          threadStages,
          selectedStageId: target?.kind === "thread"
            ? threadStages[target.id] ?? null
            : null,
        };
      },
    );
  },
});
