import { defineExtension, defineExtensionUi } from "@falcondeck/extension-sdk";

const LIBRARY_KEY = "library";
const LEGACY_PAD_KEY = "pad";
const LEGACY_NOTES_KEY = "notes";
const MAX_NOTES = 50;
const MAX_BODY_CHARS = 8_000;
const MAX_TITLE_CHARS = 60;
const MAX_LISTED_TITLES = 12;
/// The daemon rejects extension storage above 512 KiB. Refusing a little
/// earlier turns a host-level failure into a message the editor can show.
const MAX_LIBRARY_BYTES = 480 * 1024;

type Note = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

type NotesInput =
  | { operation: "read" }
  | { operation: "create"; body?: string }
  | { operation: "save"; id: string; body: string }
  | { operation: "delete"; id: string };

type StorageContext = {
  storage: {
    get<T>(key: string, fallback: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
};

/** Apple Notes derives a title from the first line; so does this. */
export function noteTitle(body: string): string {
  const line = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((candidate) =>
      candidate
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
        .replace(/^\s*>\s?/, "")
        .trim(),
    )
    .find((candidate) => candidate !== "");
  if (!line) return "New note";
  const chars = Array.from(line);
  return chars.length > MAX_TITLE_CHARS
    ? `${chars.slice(0, MAX_TITLE_CHARS).join("").trimEnd()}…`
    : line;
}

function libraryView(notes: Note[]) {
  if (notes.length === 0) {
    return defineExtensionUi({
      version: 1,
      root: {
        type: "stack",
        gap: "large",
        children: [
          { type: "text", text: "Notes", style: "heading" },
          {
            type: "text",
            text: "A quiet place for Markdown notes.",
            tone: "muted",
          },
          { type: "divider" },
          {
            type: "state",
            state: "empty",
            title: "No notes yet",
            description: "Open Notes on desktop or in the browser to write.",
          },
        ],
      },
    });
  }
  const listed = notes.slice(0, MAX_LISTED_TITLES);
  const remaining = notes.length - listed.length;
  return defineExtensionUi({
    version: 1,
    root: {
      type: "stack",
      gap: "large",
      children: [
        { type: "text", text: "Notes", style: "heading" },
        {
          type: "list",
          items: listed.map((note) => ({
            type: "text" as const,
            text: noteTitle(note.body),
          })),
        },
        {
          type: "text",
          text:
            remaining > 0
              ? `${remaining} more. Edit these on desktop or in the browser.`
              : "Edit these on desktop or in the browser.",
          tone: "muted",
        },
      ],
    },
  });
}

function isNote(value: unknown): value is Note {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const note = value as Partial<Note>;
  return (
    typeof note.id === "string" &&
    note.id !== "" &&
    typeof note.body === "string" &&
    typeof note.createdAt === "string" &&
    typeof note.updatedAt === "string"
  );
}

/** Newest first, the order the editor lists them in. */
function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function nextNoteId(notes: readonly Note[]): string {
  const highest = notes.reduce((carry, note) => {
    const match = /^note-(\d+)$/.exec(note.id);
    const value = match ? Number.parseInt(match[1]!, 10) : 0;
    return Number.isFinite(value) && value > carry ? value : carry;
  }, 0);
  return `note-${highest + 1}`;
}

function legacyNotes(value: unknown, now: string): Note[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return [];
    }
    const note = candidate as Record<string, unknown>;
    if (typeof note.body !== "string") return [];
    const createdAt = typeof note.createdAt === "string" ? note.createdAt : now;
    return [
      {
        id:
          typeof note.id === "string" && note.id !== ""
            ? note.id
            : `note-${index + 1}`,
        body: note.body,
        createdAt,
        updatedAt:
          typeof note.updatedAt === "string" ? note.updatedAt : createdAt,
      },
    ];
  });
}

/**
 * Reads the library, folding forward both earlier shapes: the single Scratch
 * pad document and, before it, an unordered note array. Migration is written
 * back so the old keys disappear on first use.
 */
async function readLibrary(context: StorageContext): Promise<Note[]> {
  const stored = await context.storage.get<unknown>(LIBRARY_KEY, null);
  if (Array.isArray(stored)) return sortNotes(stored.filter(isNote));

  const now = new Date().toISOString();
  const migrated: Note[] = [];
  const pad = await context.storage.get<unknown>(LEGACY_PAD_KEY, null);
  if (typeof pad === "string" && pad.trim() !== "") {
    migrated.push({ id: "note-1", body: pad, createdAt: now, updatedAt: now });
  }
  const legacy = legacyNotes(
    await context.storage.get<unknown>(LEGACY_NOTES_KEY, null),
    now,
  );
  for (const note of legacy) {
    migrated.push({ ...note, id: nextNoteId(migrated) });
  }
  if (migrated.length === 0) return [];
  const library = sortNotes(migrated).slice(0, MAX_NOTES);
  await writeLibrary(context, library);
  return library;
}

async function writeLibrary(
  context: StorageContext,
  notes: Note[],
): Promise<void> {
  const encoded = JSON.stringify(notes);
  if (new TextEncoder().encode(encoded).byteLength > MAX_LIBRARY_BYTES) {
    throw new Error("notes are full — delete a note to free space");
  }
  await context.storage.set(LIBRARY_KEY, notes);
  await context.storage.delete(LEGACY_PAD_KEY);
  await context.storage.delete(LEGACY_NOTES_KEY);
}

function parseInput(input: unknown): NotesInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("notes input is required");
  }
  const record = input as Record<string, unknown>;
  if (record.operation === "read") return { operation: "read" };
  if (record.operation === "create") {
    if (record.body !== undefined && typeof record.body !== "string") {
      throw new Error("create accepts a Markdown body");
    }
    return { operation: "create", body: record.body as string | undefined };
  }
  if (record.operation === "save") {
    if (typeof record.id !== "string" || record.id === "") {
      throw new Error("save requires a note id");
    }
    if (typeof record.body !== "string") {
      throw new Error("save requires a Markdown body");
    }
    return { operation: "save", id: record.id, body: record.body };
  }
  if (record.operation === "delete") {
    if (typeof record.id !== "string" || record.id === "") {
      throw new Error("delete requires a note id");
    }
    return { operation: "delete", id: record.id };
  }
  throw new Error("unknown notes operation");
}

function withTitles(notes: Note[]) {
  return notes.map((note) => ({ ...note, title: noteTitle(note.body) }));
}

export default defineExtension({
  activate(context) {
    context.actions.register("notes", async ({ input }) => {
      const request = parseInput(input);
      let notes = await readLibrary(context);

      if (request.operation === "create") {
        if (notes.length >= MAX_NOTES) {
          throw new Error("note limit reached");
        }
        const body = request.body ?? "";
        if (Array.from(body).length > MAX_BODY_CHARS) {
          throw new Error("note is too long");
        }
        const now = new Date().toISOString();
        notes = sortNotes([
          ...notes,
          { id: nextNoteId(notes), body, createdAt: now, updatedAt: now },
        ]);
        await writeLibrary(context, notes);
      } else if (request.operation === "save") {
        if (Array.from(request.body).length > MAX_BODY_CHARS) {
          throw new Error("note is too long");
        }
        const existing = notes.find((note) => note.id === request.id);
        if (!existing) throw new Error("note not found");
        if (existing.body !== request.body) {
          notes = sortNotes(
            notes.map((note) =>
              note.id === request.id
                ? {
                    ...note,
                    body: request.body,
                    updatedAt: new Date().toISOString(),
                  }
                : note,
            ),
          );
          await writeLibrary(context, notes);
        }
      } else if (request.operation === "delete") {
        const remaining = notes.filter((note) => note.id !== request.id);
        if (remaining.length !== notes.length) {
          notes = remaining;
          await writeLibrary(context, notes);
        }
      }

      await context.views.publish({
        viewId: "notes",
        value: libraryView(notes),
      });
      return { notes: withTitles(notes) };
    });
  },
});
