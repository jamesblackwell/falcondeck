import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Plus, Settings2 } from "lucide-react";
import type {
  BotApi,
  BotProfile,
  ProjectGroup,
  ThreadSummary,
} from "@falcondeck/client-core";
import { Button, Input, Textarea, cn } from "@falcondeck/ui";

export type BotSidebarControls = { bots?: BotProfile[]; botApi?: BotApi };
const EMPTY_BOTS: BotProfile[] = [];

export function BotSidebar({
  bots = EMPTY_BOTS,
  botApi,
  groups,
  selectedThreadId,
  onSelectThread,
}: BotSidebarControls & {
  groups: ProjectGroup[];
  selectedThreadId: string | null;
  onSelectThread: (workspace: string, thread: string) => void;
}) {
  const [editor, setEditor] = useState<BotProfile | "new" | null>(null);
  if (!botApi) return null;
  return (
    <section aria-label="Bots" className="mb-4">
      <div className="flex items-center justify-between px-2.5 pb-1.5">
        <h2 className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          Bots
        </h2>
        <Button
          size="icon"
          variant="ghost"
          aria-label="New bot"
          onClick={() => setEditor("new")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {bots.map((bot) => {
        const related = groups
          .flatMap((group) => group.threads)
          .filter(
            (task) =>
              task.id === bot.thread_id ||
              (task.origin?.kind === "agent_spawn" &&
                task.origin.parent_thread_id === bot.thread_id),
          );
        const working = related.some((task) => task.status === "running");
        const needsInput = related.some(
          (task) =>
            task.status === "waiting_for_input" || task.status === "error",
        );
        return (
          <div
            key={bot.id}
            className={cn(
              "group flex items-center rounded-[var(--fd-radius-md)] hover:bg-interactive-hover",
              selectedThreadId === bot.thread_id && "bg-interactive-selected",
            )}
          >
            <button
              className="fd-focus flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm text-fg-primary"
              onClick={() => onSelectThread(bot.workspace_id, bot.thread_id)}
            >
              <Bot className="h-4 w-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              {needsInput ? (
                <span className="text-xs text-warning">Needs you</span>
              ) : working ? (
                <span className="text-xs text-accent">Working</span>
              ) : null}
            </button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Edit ${bot.name}`}
              onClick={() => setEditor(bot)}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
      {bots.length === 0 ? (
        <p className="px-2.5 text-xs text-fg-muted">
          A coordinator you can keep coming back to.
        </p>
      ) : null}
      {editor ? (
        <BotEditor
          key={editor === "new" ? "new" : editor.id}
          bot={editor === "new" ? undefined : editor}
          api={botApi}
          bots={bots}
          tasks={groups.flatMap((group) => group.threads)}
          selectedThreadId={selectedThreadId}
          onClose={() => setEditor(null)}
          onSelectThread={onSelectThread}
          onCreated={(bot) => {
            setEditor(null);
            onSelectThread(bot.workspace_id, bot.thread_id);
          }}
        />
      ) : null}
    </section>
  );
}

function BotEditor({
  bot,
  api,
  bots,
  tasks,
  selectedThreadId,
  onClose,
  onCreated,
  onSelectThread,
}: {
  bot?: BotProfile;
  api: BotApi;
  bots: BotProfile[];
  tasks: ThreadSummary[];
  selectedThreadId: string | null;
  onClose: () => void;
  onCreated: (bot: BotProfile) => void;
  onSelectThread: (workspace: string, thread: string) => void;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [canStart, setCanStart] = useState(bot?.can_start_threads ?? true);
  const [threadId, setThreadId] = useState("");
  const [provider, setProvider] = useState("codex");
  const [model, setModel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const homeIds = new Set(bots.map((bot) => bot.thread_id));
  const candidates = tasks.filter(
    (task) => !homeIds.has(task.id) && !task.is_archived,
  );
  const children = bot
    ? tasks.filter(
        (task) =>
          task.origin?.kind === "agent_spawn" &&
          task.origin.parent_thread_id === bot.thread_id,
      )
    : [];
  const run = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    frame.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] p-4">
      <div
        ref={frame}
        role="dialog"
        aria-modal="true"
        aria-label={bot ? `Edit ${bot.name}` : "New bot"}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-lg)]"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== "Tab") return;
          const items = Array.from(
            frame.current?.querySelectorAll<HTMLElement>(
              "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), summary",
            ) ?? [],
          );
          if (
            document.activeElement ===
            (event.shiftKey ? items[0] : items.at(-1))
          ) {
            event.preventDefault();
            (event.shiftKey ? items.at(-1) : items[0])?.focus();
          }
        }}
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-lg font-semibold">
            {bot ? bot.name : "New bot"}
          </h2>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="space-y-5 overflow-y-auto p-5">
          <label className="block space-y-2 text-sm">
            Name
            <Input
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="Assistant"
            />
          </label>
          {!bot ? (
            <>
              <label className="block space-y-2 text-sm">
                Home conversation
                <select
                  aria-label="Home conversation"
                  className="block w-full rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 p-2"
                  value={threadId}
                  onChange={(event) => {
                    setThreadId(event.target.value);
                    if (!name)
                      setName(
                        candidates.find((t) => t.id === event.target.value)
                          ?.title ?? "",
                      );
                  }}
                >
                  <option value="">Start a new conversation</option>
                  {[...candidates]
                    .sort(
                      (a, b) =>
                        Number(b.id === selectedThreadId) -
                        Number(a.id === selectedThreadId),
                    )
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.is_pinned ? "Pinned: " : ""}
                        {task.title}
                      </option>
                    ))}
                </select>
              </label>
              {!threadId ? (
                <div className="flex gap-3">
                  <label className="flex-1 space-y-2 text-sm">
                    Harness
                    <select
                      aria-label="Harness"
                      className="block w-full rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 p-2"
                      value={provider}
                      onChange={(event) => setProvider(event.target.value)}
                    >
                      {Array.from(
                        new Set([
                          "codex",
                          "claude",
                          ...tasks.map((task) => task.provider),
                        ]),
                      ).map((provider) => (
                        <option key={provider}>{provider}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex-1 space-y-2 text-sm">
                    Model
                    <Input
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder="Harness default"
                    />
                  </label>
                </div>
              ) : null}
            </>
          ) : null}
          <label className="block space-y-2 text-sm">
            Your instructions
            <Textarea
              rows={5}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="What should this bot look after, and how should it work with you?"
            />
          </label>
          <details className="text-sm text-fg-muted">
            <summary className="cursor-pointer">FalconDeck defaults</summary>
            <p className="mt-2">
              Coordinate work through tasks in the appropriate project. Stay
              available for direction, follow up on delegated work, and bring
              back results or decisions. Keep durable knowledge in editable
              documents. Read relevant documents and respect your edits and
              deletions. Existing approval rules apply.
            </p>
          </details>
          {bot ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={canStart}
                  onChange={(event) => setCanStart(event.target.checked)}
                />
                Allow this bot to start tasks through FalconDeck
              </label>
              <BotDocuments bot={bot} api={api} />
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Delegated tasks</h3>
                {children.length ? (
                  children.map((task) => (
                    <button
                      key={task.id}
                      onClick={() => {
                        onClose();
                        onSelectThread(task.workspace_id, task.id);
                      }}
                      className="fd-focus flex w-full justify-between gap-3 text-left text-sm text-fg-muted hover:text-fg-primary"
                    >
                      <span className="truncate">{task.title}</span>
                      <span>{task.status.replaceAll("_", " ")}</span>
                    </button>
                  ))
                ) : (
                  <p className="text-sm text-fg-muted">
                    Delegated work will appear here.
                  </p>
                )}
              </div>
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {confirmDelete ? (
            <div className="space-y-2 text-sm">
              <p>
                Remove this bot? Its conversation will be archived and its
                documents kept on disk.
              </p>
              <Button
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await api.mutateBot({ action: "delete", id: bot!.id });
                    onClose();
                  })
                }
              >
                Remove bot
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-5 py-3">
          {bot ? (
            <>
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await api.mutateBot({ action: "stop", id: bot.id });
                  })
                }
              >
                Stop work
              </Button>
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirmDelete(true)}
              >
                Delete bot
              </Button>
            </>
          ) : null}
          <Button
            className="ml-auto"
            disabled={pending || !name.trim()}
            onClick={() =>
              void run(async () => {
                const result = await api.mutateBot(
                  bot
                    ? {
                        action: "update",
                        id: bot.id,
                        name,
                        instructions,
                        can_start_threads: canStart,
                      }
                    : {
                        action: "create",
                        name,
                        instructions,
                        ...(threadId
                          ? { thread_id: threadId }
                          : {
                              provider,
                              ...(model.trim()
                                ? { model_id: model.trim() }
                                : {}),
                            }),
                      },
                );
                if (!bot && result.bot) onCreated(result.bot);
                else onClose();
              })
            }
          >
            {pending ? "Saving…" : bot ? "Save changes" : "Create bot"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function BotDocuments({ bot, api }: { bot: BotProfile; api: BotApi }) {
  const [files, setFiles] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState<{
    name: string;
    version: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    let active = true;
    void api.botDocuments(bot.id).then(
      (files) => {
        if (active) setFiles(files);
      },
      (error) => {
        if (active) setError(String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [api, bot.id]);
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Documents</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setName("Untitled.md");
            setContent("");
            setOriginal(null);
            setDeleting(false);
          }}
        >
          New document
        </Button>
      </div>
      <label className="block text-sm text-fg-muted">
        Add a text document
        <input
          aria-label="Add document"
          type="file"
          accept=".md,.txt,.json,.csv,.yaml,.yml"
          disabled={pending}
          className="mt-1 block w-full text-xs"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            if (file.size > 1_048_576) {
              setError("Document must be at most 1 MB");
              return;
            }
            void run(async () => {
              setName(file.name);
              setContent(await file.text());
              setOriginal(null);
              setDeleting(false);
            });
          }}
        />
      </label>
      <p className="break-all text-xs text-fg-muted">{bot.space_path}</p>
      <div className="flex flex-wrap gap-2">
        {files.map((file) => (
          <Button
            key={file}
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const doc = await api.readBotDocument(bot.id, file);
                setName(doc.name);
                setContent(doc.content);
                setOriginal({ name: doc.name, version: doc.version });
                setDeleting(false);
              })
            }
          >
            {file}
          </Button>
        ))}
      </div>
      {name ? (
        <div className="space-y-2">
          <Input
            aria-label="Document name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Textarea
            aria-label="Document content"
            rows={7}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending || !name.trim()}
              onClick={() =>
                void run(async () => {
                  await api.mutateBotDocument(bot.id, {
                    action: "write",
                    name,
                    content,
                    expected_version:
                      original?.name === name ? original.version : null,
                  });
                  setFiles(await api.botDocuments(bot.id));
                  setName("");
                })
              }
            >
              Save document
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending || original?.name !== name}
              onClick={() => setDeleting(true)}
            >
              Delete document
            </Button>
          </div>
          {deleting ? (
            <div className="text-sm">
              <p>Delete {name} from disk?</p>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await api.mutateBotDocument(bot.id, {
                      action: "delete",
                      name,
                      expected_version: original?.version ?? "",
                    });
                    setFiles(await api.botDocuments(bot.id));
                    setName("");
                    setDeleting(false);
                  })
                }
              >
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDeleting(false)}
              >
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
