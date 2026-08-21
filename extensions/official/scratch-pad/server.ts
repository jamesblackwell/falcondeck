import { defineExtension, defineExtensionUi } from "@falcondeck/extension-sdk";

const PAD_KEY = "pad";
const LEGACY_NOTES_KEY = "notes";
const MAX_BODY_CHARS = 8_000;
const MAX_PREVIEW_CHARS = 240;

type NotesInput = { operation: "read" } | { operation: "save"; body: string };

type LegacyNote = {
  body?: unknown;
  updatedAt?: unknown;
};

function padView(body: string) {
  const trimmed = body.trim();
  if (!trimmed) {
    return defineExtensionUi({
      version: 1,
      root: {
        type: "stack",
        gap: "large",
        children: [
          { type: "text", text: "Scratch pad", style: "heading" },
          {
            type: "text",
            text: "A quiet place for a Markdown note.",
            tone: "muted",
          },
          { type: "divider" },
          {
            type: "state",
            state: "empty",
            title: "Empty",
            description: "Open Scratch pad on desktop or in the browser to write.",
          },
        ],
      },
    });
  }
  const chars = Array.from(trimmed);
  const preview =
    chars.length > MAX_PREVIEW_CHARS
      ? `${chars.slice(0, MAX_PREVIEW_CHARS).join("")}…`
      : trimmed;
  return defineExtensionUi({
    version: 1,
    root: {
      type: "stack",
      gap: "large",
      children: [
        { type: "text", text: "Scratch pad", style: "heading" },
        { type: "text", text: preview, style: "mono" },
        {
          type: "text",
          text: "Edit this note on desktop or in the browser.",
          tone: "muted",
        },
      ],
    },
  });
}

function legacyBody(notes: unknown): string | null {
  if (!Array.isArray(notes) || notes.length === 0) return null;
  const ranked = notes
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return [];
      }
      const note = candidate as LegacyNote;
      return typeof note.body === "string"
        ? [
            {
              body: note.body,
              updatedAt:
                typeof note.updatedAt === "string" ? note.updatedAt : "",
            },
          ]
        : [];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return ranked[0]?.body ?? null;
}

async function readPad(context: {
  storage: {
    get<T>(key: string, fallback: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
}): Promise<string> {
  const current = await context.storage.get<string | null>(PAD_KEY, null);
  if (typeof current === "string") return current;
  const migrated = legacyBody(
    await context.storage.get<unknown>(LEGACY_NOTES_KEY, null),
  );
  if (migrated == null) return "";
  await context.storage.set(PAD_KEY, migrated);
  await context.storage.delete(LEGACY_NOTES_KEY);
  return migrated;
}

function parseInput(input: unknown): NotesInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("scratch pad input is required");
  }
  const record = input as Record<string, unknown>;
  if (record.operation === "read") return { operation: "read" };
  if (record.operation === "save") {
    if (typeof record.body !== "string") {
      throw new Error("save requires a Markdown body");
    }
    return { operation: "save", body: record.body };
  }
  throw new Error("unknown scratch pad operation");
}

export default defineExtension({
  activate(context) {
    context.actions.register("notes", async ({ input }) => {
      const request = parseInput(input);

      if (request.operation === "read") {
        const body = await readPad(context);
        await context.views.publish({
          viewId: "scratch-pad",
          value: padView(body),
        });
        return { body };
      }

      if (Array.from(request.body).length > MAX_BODY_CHARS) {
        throw new Error("note is too long");
      }
      await context.storage.set(PAD_KEY, request.body);
      await context.storage.delete(LEGACY_NOTES_KEY);
      await context.views.publish({
        viewId: "scratch-pad",
        value: padView(request.body),
      });
      return { body: request.body };
    });
  },
});
