import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  defineExtensionApp,
  type ExtensionAppPanelProps,
} from "@falcondeck/extension-sdk/app";

const SAVE_DELAY_MS = 400;

type Note = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

function parseNotes(value: unknown): Note[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Notes returned an invalid response");
  }
  const notes = (value as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) {
    throw new Error("Notes returned an invalid library");
  }
  return notes.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Notes returned an invalid note");
    }
    const note = candidate as Partial<Note>;
    if (typeof note.id !== "string" || typeof note.body !== "string") {
      throw new Error("Notes returned an invalid note");
    }
    return {
      id: note.id,
      title: typeof note.title === "string" ? note.title : "New note",
      body: note.body,
      createdAt: note.createdAt ?? "",
      updatedAt: note.updatedAt ?? "",
    };
  });
}

function relativeDay(iso: string): string {
  const updated = new Date(iso);
  if (Number.isNaN(updated.getTime())) return "";
  const now = new Date();
  const sameDay = updated.toDateString() === now.toDateString();
  if (sameDay) {
    return updated.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (updated.toDateString() === yesterday.toDateString()) return "Yesterday";
  return updated.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: updated.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** The first line of body text after the title line, as Apple Notes shows it. */
function snippet(body: string, title: string): string {
  const lines = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const rest = lines.slice(1).join(" ");
  const text = rest || (lines[0] === title ? "" : (lines[0] ?? ""));
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded-[var(--fd-radius-sm)] bg-surface-3 px-1 font-mono text-[length:var(--fd-text-sm)]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const label = token.slice(1, token.indexOf("]"));
      nodes.push(
        <span key={key} className="text-accent underline decoration-accent/40">
          {label}
        </span>,
      );
    }
    last = match.index + token.length;
    index += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function MarkdownPreview({ body }: { body: string }) {
  const blocks = useMemo(() => {
    const lines = body.replace(/\r\n/g, "\n").split("\n");
    const items: Array<
      | { type: "heading"; level: 1 | 2 | 3; text: string }
      | { type: "code"; text: string }
      | { type: "list"; ordered: boolean; items: string[] }
      | { type: "quote"; text: string }
      | { type: "paragraph"; text: string }
    > = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.startsWith("```")) {
        const code: string[] = [];
        index += 1;
        while (index < lines.length && !lines[index]!.startsWith("```")) {
          code.push(lines[index]!);
          index += 1;
        }
        if (index < lines.length) index += 1;
        items.push({ type: "code", text: code.join("\n") });
        continue;
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        items.push({
          type: "heading",
          level: heading[1]!.length as 1 | 2 | 3,
          text: heading[2]!,
        });
        index += 1;
        continue;
      }
      const unordered = /^[-*]\s+/.test(line);
      const ordered = /^\d+\.\s+/.test(line);
      if (unordered || ordered) {
        const listItems: string[] = [];
        const itemPattern = unordered ? /^[-*]\s+/ : /^\d+\.\s+/;
        while (index < lines.length && itemPattern.test(lines[index]!)) {
          listItems.push(lines[index]!.replace(itemPattern, ""));
          index += 1;
        }
        items.push({ type: "list", ordered, items: listItems });
        continue;
      }
      if (line.startsWith("> ")) {
        items.push({ type: "quote", text: line.slice(2) });
        index += 1;
        continue;
      }
      const paragraph: string[] = [line];
      index += 1;
      while (
        index < lines.length &&
        !lines[index]!.startsWith("#") &&
        !lines[index]!.startsWith("```") &&
        !lines[index]!.startsWith("> ") &&
        !/^[-*]\s+/.test(lines[index]!) &&
        !/^\d+\.\s+/.test(lines[index]!)
      ) {
        paragraph.push(lines[index]!);
        index += 1;
      }
      items.push({ type: "paragraph", text: paragraph.join("\n") });
    }
    return items;
  }, [body]);

  if (body.trim() === "") {
    return <p className="text-fg-muted">Nothing to preview yet.</p>;
  }

  return (
    <div className="space-y-3 text-[length:var(--fd-text-md)] leading-relaxed text-fg-primary">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const size =
            block.level === 1
              ? "text-[length:var(--fd-text-xl)]"
              : block.level === 2
                ? "text-[length:var(--fd-text-lg)]"
                : "text-[length:var(--fd-text-md)]";
          return (
            <h2 key={index} className={`${size} font-semibold text-fg-primary`}>
              {renderInline(block.text, `h-${index}`)}
            </h2>
          );
        }
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded-[var(--fd-radius-md)] bg-surface-3 p-3 font-mono text-[length:var(--fd-text-sm)] text-fg-secondary"
            >
              {block.text}
            </pre>
          );
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={index}
              className={
                block.ordered
                  ? "list-decimal space-y-1 pl-5"
                  : "list-disc space-y-1 pl-5"
              }
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  {renderInline(item, `l-${index}-${itemIndex}`)}
                </li>
              ))}
            </List>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote
              key={index}
              className="border-l-2 border-border-default pl-3 text-fg-secondary"
            >
              {renderInline(block.text, `q-${index}`)}
            </blockquote>
          );
        }
        return (
          <p key={index} className="whitespace-pre-wrap">
            {renderInline(block.text, `p-${index}`)}
          </p>
        );
      })}
    </div>
  );
}

function Notes({ invokeAction }: ExtensionAppPanelProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  const dirtyRef = useRef(dirty);
  const activeIdRef = useRef(activeId);
  const saveTimer = useRef<number | null>(null);
  const saveSeq = useRef(0);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  draftRef.current = draft;
  dirtyRef.current = dirty;
  activeIdRef.current = activeId;

  const run = useCallback(
    async (input: unknown) => {
      const response = await invokeAction("notes", input);
      return parseNotes(response.result);
    },
    [invokeAction],
  );

  const describe = useCallback((reason: unknown, fallback: string) => {
    return reason instanceof Error && reason.message
      ? reason.message
      : fallback;
  }, []);

  const flushSave = useCallback(async () => {
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const id = activeIdRef.current;
    if (!dirtyRef.current || !id) return;
    const seq = ++saveSeq.current;
    const body = draftRef.current;
    setSaving(true);
    try {
      const saved = await run({ operation: "save", id, body });
      if (seq !== saveSeq.current) return;
      // Merge without reordering: the list should not shuffle mid-sentence.
      setNotes((current) =>
        current.map((note) => {
          const next = saved.find((candidate) => candidate.id === note.id);
          return next ?? note;
        }),
      );
      setDirty(false);
      setError(null);
    } catch (reason) {
      if (seq !== saveSeq.current) return;
      setError(describe(reason, "Could not save the note"));
    } finally {
      if (seq === saveSeq.current) setSaving(false);
    }
  }, [describe, run]);

  useEffect(() => {
    let active = true;
    void run({ operation: "read" })
      .then((loaded) => {
        if (!active) return;
        setNotes(loaded);
        setActiveId(loaded[0]?.id ?? null);
        setDraft(loaded[0]?.body ?? "");
        setDirty(false);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(describe(reason, "Could not load your notes"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [describe, run]);

  useEffect(() => {
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      if (dirtyRef.current && activeIdRef.current) {
        void invokeAction("notes", {
          operation: "save",
          id: activeIdRef.current,
          body: draftRef.current,
        });
      }
    };
  }, [invokeAction]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void flushSave();
    }, SAVE_DELAY_MS);
  }, [flushSave]);

  const selectNote = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return;
      await flushSave();
      const note = notes.find((candidate) => candidate.id === id);
      if (!note) return;
      setActiveId(id);
      setDraft(note.body);
      setDirty(false);
      setMode("write");
    },
    [flushSave, notes],
  );

  const createNote = useCallback(async () => {
    await flushSave();
    try {
      const saved = await run({ operation: "create" });
      const known = new Set(notes.map((note) => note.id));
      const created =
        saved.find((note) => !known.has(note.id)) ?? saved[0] ?? null;
      setNotes(saved);
      setActiveId(created?.id ?? null);
      setDraft(created?.body ?? "");
      setDirty(false);
      setMode("write");
      setQuery("");
      setError(null);
      window.setTimeout(() => editorRef.current?.focus(), 0);
    } catch (reason) {
      setError(describe(reason, "Could not create a note"));
    }
  }, [describe, flushSave, notes, run]);

  const deleteNote = useCallback(
    async (id: string) => {
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      // Abandon any in-flight save for the note being removed.
      saveSeq.current += 1;
      setDirty(false);
      try {
        const remaining = await run({ operation: "delete", id });
        setNotes(remaining);
        if (activeIdRef.current === id) {
          setActiveId(remaining[0]?.id ?? null);
          setDraft(remaining[0]?.body ?? "");
          setMode("write");
        }
        setError(null);
      } catch (reason) {
        setError(describe(reason, "Could not delete the note"));
      }
    },
    [describe, run],
  );

  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter((note) =>
      `${note.title}\n${note.body}`.toLowerCase().includes(needle),
    );
  }, [notes, query]);

  const activeNote = notes.find((note) => note.id === activeId) ?? null;
  const activeTitle = activeNote
    ? dirty
      ? deriveTitle(draft)
      : activeNote.title
    : "";

  if (loading) {
    return <div className="p-6 text-fg-muted">Loading Notes…</div>;
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-surface-1">
        <div className="flex shrink-0 items-center gap-2 px-3 py-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search notes"
            placeholder="Search"
            className="fd-focus min-w-0 flex-1 rounded-[var(--fd-radius-md)] bg-surface-2 px-2.5 py-1.5 text-[length:var(--fd-text-xs)] text-fg-primary outline-none placeholder:text-fg-muted"
          />
          <button
            type="button"
            onClick={() => void createNote()}
            aria-label="New note"
            title="New note"
            className="fd-focus flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--fd-radius-md)] bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
          >
            <span
              aria-hidden="true"
              className="text-[length:var(--fd-text-md)] leading-none"
            >
              +
            </span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {visibleNotes.length === 0 ? (
            <p className="px-2 py-6 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
              {notes.length === 0 ? "No notes yet" : "No matches"}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {visibleNotes.map((note) => {
                const selected = note.id === activeId;
                const title =
                  selected && dirty ? deriveTitle(draft) : note.title;
                const body = selected && dirty ? draft : note.body;
                return (
                  <li key={note.id} className="group relative">
                    <button
                      type="button"
                      aria-current={selected ? "true" : undefined}
                      onClick={() => void selectNote(note.id)}
                      className={`fd-focus w-full rounded-[var(--fd-radius-md)] px-2.5 py-2 text-left ${
                        selected
                          ? "bg-surface-3 text-fg-primary"
                          : "text-fg-secondary hover:bg-surface-2"
                      }`}
                    >
                      <span className="block truncate text-[length:var(--fd-text-sm)] font-medium">
                        {title}
                      </span>
                      <span className="mt-0.5 flex gap-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
                        <span className="shrink-0">
                          {relativeDay(note.updatedAt)}
                        </span>
                        <span className="min-w-0 truncate">
                          {snippet(body, title)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteNote(note.id)}
                      aria-label={`Delete ${title}`}
                      className="fd-focus absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-[var(--fd-radius-sm)] bg-surface-3 text-fg-muted hover:text-danger group-hover:flex"
                    >
                      <span aria-hidden="true" className="leading-none">
                        ×
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {error ? (
          <div
            role="alert"
            className="border-b border-danger/30 bg-danger-muted px-5 py-2 text-[length:var(--fd-text-sm)] text-danger"
          >
            {error}
          </div>
        ) : null}
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
            {activeTitle}
          </span>
          {activeNote ? (
            <>
              <span className="shrink-0 text-[length:var(--fd-text-xs)] text-fg-muted">
                {saving ? "Saving…" : dirty ? "Editing" : "Saved"}
              </span>
              <div className="flex shrink-0 rounded-[var(--fd-radius-md)] bg-surface-2 p-0.5">
                <button
                  type="button"
                  aria-pressed={mode === "write"}
                  onClick={() => setMode("write")}
                  className={`fd-focus rounded-[var(--fd-radius-sm)] px-2.5 py-1 text-[length:var(--fd-text-xs)] ${
                    mode === "write"
                      ? "bg-surface-4 text-fg-primary"
                      : "text-fg-muted hover:text-fg-primary"
                  }`}
                >
                  Write
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "preview"}
                  onClick={() => {
                    void flushSave();
                    setMode("preview");
                  }}
                  className={`fd-focus rounded-[var(--fd-radius-sm)] px-2.5 py-1 text-[length:var(--fd-text-xs)] ${
                    mode === "preview"
                      ? "bg-surface-4 text-fg-primary"
                      : "text-fg-muted hover:text-fg-primary"
                  }`}
                >
                  Preview
                </button>
              </div>
            </>
          ) : null}
        </div>
        {!activeNote ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-fg-muted">
              {notes.length === 0
                ? "No notes yet."
                : "Select a note from the list."}
            </p>
            <button
              type="button"
              onClick={() => void createNote()}
              className="fd-focus rounded-[var(--fd-radius-md)] bg-surface-3 px-3 py-1.5 text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-4"
            >
              New note
            </button>
          </div>
        ) : mode === "write" ? (
          <textarea
            ref={editorRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
              scheduleSave();
            }}
            onBlur={() => void flushSave()}
            aria-label="Note"
            placeholder="Write a Markdown note…"
            className="min-h-0 w-full flex-1 resize-none self-center bg-transparent px-6 py-5 text-[length:var(--fd-text-md)] leading-relaxed text-fg-primary outline-none placeholder:text-fg-muted md:max-w-3xl"
          />
        ) : (
          <div
            aria-label="Note preview"
            className="min-h-0 w-full flex-1 self-center overflow-y-auto px-6 py-5 md:max-w-3xl"
          >
            <MarkdownPreview body={draft} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Mirrors the daemon-side title rule so the list updates while you type. */
function deriveTitle(body: string): string {
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
  return chars.length > 60 ? `${chars.slice(0, 60).join("").trimEnd()}…` : line;
}

export default defineExtensionApp("falcondeck.notes", (app) => {
  app.panels.register({
    id: "library",
    title: "Notes",
    icon: "notebook-pen",
    component: Notes,
  });
});
