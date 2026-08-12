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
type LegacyTag = { id: string; color: string };
type LegacyAssignments = Record<string, string[]>;
type ThreadColors = Record<string, Color>;
type ManageColorsInput =
  | { operation: "read" }
  | { operation: "set_thread_color"; color: Color | null };

const THREAD_COLORS_KEY = "threadColors";
const LEGACY_TAGS_KEY = "tags";
const LEGACY_ASSIGNMENTS_KEY = "assignments";
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
const PALETTE = COLORS.map((color) => ({
  id: color,
  label: color[0]!.toUpperCase() + color.slice(1),
  color,
}));

function threadScope(threadId: string): ExtensionViewScope {
  return { kind: "thread", id: threadId };
}

async function readThreadColors(
  context: ExtensionContext,
): Promise<ThreadColors> {
  const current = await context.storage.get<ThreadColors | null>(
    THREAD_COLORS_KEY,
    null,
  );
  if (current !== null) return current;

  // v0.1 allowed named, multi-value tags. Preserve the first assigned colour
  // while moving to Finder-style one-colour labels.
  const legacyTags = await context.storage.get<LegacyTag[]>(
    LEGACY_TAGS_KEY,
    [],
  );
  const legacyAssignments = await context.storage.get<LegacyAssignments>(
    LEGACY_ASSIGNMENTS_KEY,
    {},
  );
  const colorByTagId = new Map(
    legacyTags.flatMap((tag) =>
      ALLOWED_COLORS.has(tag.color as Color)
        ? [[tag.id, tag.color as Color]]
        : []
    ),
  );
  const migrated = Object.fromEntries(
    Object.entries(legacyAssignments).flatMap(([threadId, tagIds]) => {
      const color = tagIds.map((tagId) => colorByTagId.get(tagId)).find(
        Boolean,
      );
      return color ? [[threadId, color]] : [];
    }),
  );
  await context.storage.set(THREAD_COLORS_KEY, migrated);
  await context.storage.delete(LEGACY_TAGS_KEY);
  await context.storage.delete(LEGACY_ASSIGNMENTS_KEY);
  return migrated;
}

export default defineExtension({
  activate(context) {
    context.actions.register<ManageColorsInput>(
      "manage-tags",
      async ({ target, input }) => {
        const threadColors = await readThreadColors(context);

        if (input.operation === "set_thread_color") {
          if (target?.kind !== "thread") {
            throw new Error("set_thread_color requires a thread target");
          }
          if (input.color === null) delete threadColors[target.id];
          else if (ALLOWED_COLORS.has(input.color)) {
            threadColors[target.id] = input.color;
          } else throw new Error("unsupported thread colour");
          await context.storage.set(THREAD_COLORS_KEY, threadColors);
          await context.views.publish({
            viewId: "thread-tags",
            scope: threadScope(target.id),
            value: {
              tagIds: threadColors[target.id] ? [threadColors[target.id]] : [],
            },
          });
        }

        await context.views.publish({
          viewId: "tag-index",
          value: { tags: PALETTE },
        });
        return {
          colors: PALETTE,
          selectedColor: target?.kind === "thread"
            ? threadColors[target.id] ?? null
            : null,
        };
      },
    );
  },
});
