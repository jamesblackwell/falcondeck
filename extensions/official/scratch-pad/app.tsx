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

function parseBody(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scratch pad returned an invalid response");
  }
  const body = (value as { body?: unknown }).body;
  if (typeof body !== "string") {
    throw new Error("Scratch pad returned an invalid note");
  }
  return body;
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
            <h2
              key={index}
              className={`${size} font-semibold text-fg-primary`}
            >
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

function ScratchPad({ invokeAction }: ExtensionAppPanelProps) {
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  const dirtyRef = useRef(dirty);
  const saveTimer = useRef<number | null>(null);
  const saveSeq = useRef(0);

  draftRef.current = draft;
  dirtyRef.current = dirty;

  const run = useCallback(
    async (input: unknown) => {
      const response = await invokeAction("notes", input);
      return parseBody(response.result);
    },
    [invokeAction],
  );

  const flushSave = useCallback(async () => {
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!dirtyRef.current) return;
    const seq = ++saveSeq.current;
    const body = draftRef.current;
    setSaving(true);
    try {
      await run({ operation: "save", body });
      if (seq !== saveSeq.current) return;
      setDirty(false);
      setError(null);
    } catch (reason) {
      if (seq !== saveSeq.current) return;
      setError(
        reason instanceof Error ? reason.message : "Could not save the note",
      );
    } finally {
      if (seq === saveSeq.current) setSaving(false);
    }
  }, [run]);

  useEffect(() => {
    let active = true;
    void run({ operation: "read" })
      .then((body) => {
        if (!active) return;
        setDraft(body);
        setDirty(false);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error ? reason.message : "Could not load the note",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [run]);

  useEffect(() => {
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      if (dirtyRef.current) {
        void invokeAction("notes", {
          operation: "save",
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

  if (loading) {
    return <div className="p-6 text-fg-muted">Loading Scratch pad…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div
          role="alert"
          className="border-b border-danger/30 bg-danger-muted px-5 py-2 text-[length:var(--fd-text-sm)] text-danger"
        >
          {error}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2">
        <div className="flex rounded-[var(--fd-radius-md)] bg-surface-2 p-0.5">
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
        <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)] text-fg-muted">
          {saving ? "Saving…" : dirty ? "Editing" : "Saved"}
        </span>
      </div>
      {mode === "write" ? (
        <textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(true);
            scheduleSave();
          }}
          onBlur={() => void flushSave()}
          aria-label="Scratch pad"
          placeholder="Write a Markdown note…"
          className="min-h-0 flex-1 resize-none bg-transparent px-5 py-4 text-[length:var(--fd-text-md)] leading-relaxed text-fg-primary outline-none placeholder:text-fg-muted"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <MarkdownPreview body={draft} />
        </div>
      )}
    </div>
  );
}

export default defineExtensionApp("falcondeck.scratch-pad", (app) => {
  app.panels.register({
    id: "pad",
    title: "Scratch pad",
    icon: "notebook-pen",
    component: ScratchPad,
  });
});
