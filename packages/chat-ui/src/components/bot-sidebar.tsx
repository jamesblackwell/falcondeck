import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Check,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderPlus,
  Plus,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import {
  BOT_ICON_COLORS,
  BOT_ICON_SHAPES,
  defaultProviderLabel,
  resolveBotIcons,
  workspaceColorCssVar,
  type BotApi,
  type BotContextReport,
  type BotIcon,
  type BotProfile,
  type ContextFileContent,
  type ContextFileList,
  type ProjectGroup,
  type ThreadSummary,
} from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Button,
  CopyButton,
  Input,
  SearchField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  cn,
} from "@falcondeck/ui";
import { BotMark } from "./bot-mark";
import { ProviderIcon } from "./provider-icon";

export type BotSidebarControls = { bots?: BotProfile[]; botApi?: BotApi };
const EMPTY_BOTS: BotProfile[] = [];

const SECTION_ICON_BUTTON_CLASS =
  "fd-focus -my-0.5 shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary";
const FIELD_LABEL_CLASS =
  "block text-[length:var(--fd-text-sm)] font-medium text-fg-primary";
const HINT_CLASS =
  "text-[length:var(--fd-text-xs)] leading-relaxed text-fg-muted";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function botActivity(bot: BotProfile, tasks: ThreadSummary[]) {
  const related = tasks.filter(
    (task) =>
      task.id === bot.thread_id ||
      (task.origin?.kind === "agent_spawn" &&
        task.origin.parent_thread_id === bot.thread_id),
  );
  if (
    related.some(
      (task) =>
        task.status === "waiting_for_input" || task.status === "error",
    )
  )
    return "needs_input";
  return related.some((task) => task.status === "running") ? "working" : null;
}

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
  const icons = useMemo(() => resolveBotIcons(bots), [bots]);
  const tasks = useMemo(() => groups.flatMap((group) => group.threads), [groups]);
  if (!botApi) return null;
  return (
    <section aria-labelledby="fd-bots-heading" className="mb-4">
      <div className="flex items-center justify-between pb-1.5 pl-2.5 pr-2">
        <h2 id="fd-bots-heading" className="fd-type-eyebrow text-fg-muted">
          Bots
        </h2>
        <button
          type="button"
          aria-label="New bot"
          title="New bot"
          className={SECTION_ICON_BUTTON_CLASS}
          onClick={() => setEditor("new")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {bots.map((bot) => {
        const activity = botActivity(bot, tasks);
        const icon = icons.get(bot.id);
        const selected = selectedThreadId === bot.thread_id;
        return (
          <div
            key={bot.id}
            className={cn(
              "group flex items-center gap-1 rounded-[var(--fd-radius-md)] pr-1.5 transition-colors duration-[var(--fd-duration-hover)]",
              selected
                ? "fd-row-selected"
                : "hover:bg-interactive-hover active:bg-interactive-selected",
            )}
          >
            <button
              type="button"
              className="fd-focus-inset flex min-w-0 flex-1 items-center gap-2 rounded-[var(--fd-radius-sm)] py-2 pl-2.5 text-left"
              onClick={() => onSelectThread(bot.workspace_id, bot.thread_id)}
            >
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center",
                  selected ? "text-accent" : "text-fg-muted",
                )}
              >
                {activity === "needs_input" ? (
                  <span className="h-2.5 w-2.5 rounded-full bg-warning shadow-[0_0_0_3px_var(--fd-warning-muted)]" />
                ) : icon ? (
                  <BotMark icon={icon} working={activity === "working"} />
                ) : (
                  <Bot aria-hidden="true" className="h-3.5 w-3.5" />
                )}
              </span>
              <span
                className={cn(
                  "fd-type-supporting min-w-0 flex-1 truncate transition-colors duration-[var(--fd-duration-fast)]",
                  selected
                    ? "text-fg-primary"
                    : "text-fg-secondary group-hover:text-fg-primary",
                )}
              >
                {bot.name}
              </span>
              {activity === "needs_input" ? (
                <span className="fd-type-meta shrink-0 text-warning">
                  Needs you
                </span>
              ) : activity === "working" ? (
                <span className="fd-type-meta shrink-0 text-fg-muted">
                  Working
                </span>
              ) : null}
            </button>
            <button
              type="button"
              aria-label={`Edit ${bot.name}`}
              title="Bot settings"
              className={cn(
                SECTION_ICON_BUTTON_CLASS,
                "opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100",
              )}
              onClick={() => setEditor(bot)}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      {bots.length === 0 ? (
        <button
          type="button"
          onClick={() => setEditor("new")}
          className="fd-focus group flex w-full items-start gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-2 text-left transition-colors duration-[var(--fd-duration-hover)] hover:bg-interactive-hover"
        >
          <span className="flex h-5 w-4 shrink-0 items-center justify-center text-fg-muted group-hover:text-fg-secondary">
            <Bot aria-hidden="true" className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0">
            <span className="fd-type-supporting block text-fg-secondary group-hover:text-fg-primary">
              Create a bot
            </span>
            <span className="fd-type-meta block text-fg-muted">
              A coordinator you can keep coming back to.
            </span>
          </span>
        </button>
      ) : null}
      {editor ? (
        <BotEditor
          key={editor === "new" ? "new" : editor.id}
          bot={editor === "new" ? undefined : editor}
          api={botApi}
          bots={bots}
          groups={groups}
          tasks={tasks}
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className={FIELD_LABEL_CLASS}>
        {label}
      </label>
      {children(id)}
      {hint ? <p className={HINT_CLASS}>{hint}</p> : null}
    </div>
  );
}

function EditorSection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-border-subtle pt-5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h3 className="fd-type-eyebrow text-fg-muted">{title}</h3>
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

const STATUS_LABELS: Partial<Record<ThreadSummary["status"], string>> = {
  running: "Working",
  waiting_for_input: "Needs you",
  error: "Error",
  idle: "Idle",
};

function TaskStatus({ status }: { status: ThreadSummary["status"] }) {
  return (
    <span
      className={cn(
        "fd-type-meta flex shrink-0 items-center gap-1.5",
        status === "waiting_for_input"
          ? "text-warning"
          : status === "error"
            ? "text-danger"
            : "text-fg-muted",
      )}
    >
      {status === "running" ? <ActivityDiamond /> : null}
      {STATUS_LABELS[status] ?? status.replaceAll("_", " ")}
    </span>
  );
}

function BotEditor({
  bot,
  api,
  bots,
  groups,
  tasks,
  selectedThreadId,
  onClose,
  onCreated,
  onSelectThread,
}: {
  bot?: BotProfile;
  api: BotApi;
  bots: BotProfile[];
  groups: ProjectGroup[];
  tasks: ThreadSummary[];
  selectedThreadId: string | null;
  onClose: () => void;
  onCreated: (bot: BotProfile) => void;
  onSelectThread: (workspace: string, thread: string) => void;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [canStart, setCanStart] = useState(bot?.can_start_threads ?? true);
  const [contextFiles, setContextFiles] = useState(bot?.context_files ?? []);
  const [icon, setIcon] = useState<BotIcon | undefined>(() =>
    bot ? resolveBotIcons(bots).get(bot.id) : undefined,
  );
  const [home, setHome] = useState<"new" | "existing">("new");
  const [threadId, setThreadId] = useState("");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("codex");
  const [model, setModel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const frame = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const projectNames = useMemo(
    () =>
      new Map(
        groups.map((group) => [
          group.workspace.id,
          group.workspace.path.split("/").filter(Boolean).at(-1) ?? "",
        ]),
      ),
    [groups],
  );
  const candidates = useMemo(() => {
    const homeIds = new Set(bots.map((bot) => bot.thread_id));
    const needle = query.trim().toLowerCase();
    return tasks
      .filter((task) => !homeIds.has(task.id) && !task.is_archived)
      .filter(
        (task) =>
          !needle ||
          task.title.toLowerCase().includes(needle) ||
          projectNames.get(task.workspace_id)?.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          Number(b.id === selectedThreadId) -
            Number(a.id === selectedThreadId) ||
          Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)),
      );
  }, [bots, projectNames, query, selectedThreadId, tasks]);
  const providers = useMemo(
    () =>
      Array.from(
        new Set(["codex", "claude", ...tasks.map((task) => task.provider)]),
      ),
    [tasks],
  );
  const children = bot
    ? tasks.filter(
        (task) =>
          task.origin?.kind === "agent_spawn" &&
          task.origin.parent_thread_id === bot.thread_id,
      )
    : [];
  const promoting = !bot && home === "existing";
  const canSubmit =
    !pending && Boolean(name.trim()) && (!promoting || Boolean(threadId));
  const close = () => {
    if (!pending) onClose();
  };
  const run = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const submit = () =>
    void run(async () => {
      const result = await api.mutateBot(
        bot
          ? {
              action: "update",
              id: bot.id,
              name,
              instructions,
              can_start_threads: canStart,
              ...(api.contextFiles ? { context_files: contextFiles } : {}),
              ...(icon ? { icon } : {}),
            }
          : {
              action: "create",
              name,
              instructions,
              ...(promoting
                ? { thread_id: threadId }
                : {
                    provider,
                    ...(model.trim() ? { model_id: model.trim() } : {}),
                  }),
            },
      );
      if (!bot && result.bot) onCreated(result.bot);
      else onClose();
    });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    frame.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        ref={frame}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "flex max-h-[min(88vh,52rem)] w-full flex-col overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-lg)]",
          bot ? "max-w-2xl" : "max-w-xl",
        )}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) submit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== "Tab") return;
          const items = Array.from(
            frame.current?.querySelectorAll<HTMLElement>(
              "input:not(:disabled):not([tabindex='-1']), textarea:not(:disabled), button:not(:disabled), summary",
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
        <header className="flex items-start gap-3 px-6 pb-5 pt-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 text-accent">
            {icon ? (
              <BotMark icon={icon} size={20} />
            ) : (
              <Bot aria-hidden="true" className="h-5 w-5" />
            )}
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <h2
              id={titleId}
              className="fd-type-heading fd-type-heading--sm truncate text-fg-primary"
            >
              {bot ? bot.name : "New bot"}
            </h2>
            <p className="fd-type-meta text-fg-muted">
              {bot
                ? "Bot settings"
                : "A standing coordinator that delegates tasks and keeps notes between conversations."}
            </p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Close"
            disabled={pending}
            onClick={onClose}
            className="-mr-2 -mt-1"
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Release captain"
              />
            )}
          </Field>
          {!bot ? (
            <div className="space-y-2">
              <span className={FIELD_LABEL_CLASS}>Home conversation</span>
              <div
                role="radiogroup"
                aria-label="Home conversation"
                className="grid grid-cols-2 gap-1 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 p-1"
              >
                {(
                  [
                    ["new", "Start fresh"],
                    ["existing", "Promote a task"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={home === value}
                    onClick={() => setHome(value)}
                    className={cn(
                      "fd-focus h-8 rounded-[var(--fd-radius-md)] text-[length:var(--fd-text-sm)] font-medium transition-colors duration-[var(--fd-duration-fast)]",
                      home === value
                        ? "bg-surface-4 text-fg-primary shadow-[var(--fd-shadow-sm)]"
                        : "text-fg-muted hover:text-fg-secondary",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {home === "new" ? (
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div className="space-y-2">
                    <span className={HINT_CLASS}>Harness</span>
                    <Select value={provider} onValueChange={setProvider}>
                      <SelectTrigger
                        aria-label="Harness"
                        className="h-9 w-full rounded-[var(--fd-radius-lg)] bg-surface-2 text-[length:var(--fd-text-sm)] text-fg-primary"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ProviderIcon provider={provider} />
                          <SelectValue />
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {providers.map((id) => (
                          <SelectItem
                            key={id}
                            value={id}
                            leading={<ProviderIcon provider={id} />}
                          >
                            {defaultProviderLabel(id)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <span className={HINT_CLASS}>Model</span>
                    <Input
                      aria-label="Model"
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder="Harness default"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-2 pt-2">
                  <SearchField
                    label="Search tasks"
                    placeholder="Search tasks"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <div
                    role="listbox"
                    aria-label="Task to promote"
                    className="max-h-56 overflow-y-auto rounded-[var(--fd-radius-lg)] border border-border-subtle p-1"
                  >
                    {candidates.length ? (
                      candidates.map((task) => {
                        const picked = task.id === threadId;
                        return (
                          <button
                            key={task.id}
                            type="button"
                            role="option"
                            aria-selected={picked}
                            onClick={() => {
                              setThreadId(task.id);
                              if (!name.trim()) setName(task.title);
                            }}
                            className={cn(
                              "fd-focus flex w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-2 text-left transition-colors duration-[var(--fd-duration-fast)]",
                              picked
                                ? "bg-interactive-selected"
                                : "hover:bg-interactive-hover",
                            )}
                          >
                            <ProviderIcon
                              provider={task.provider}
                              className="text-fg-muted"
                            />
                            <span className="fd-type-supporting min-w-0 flex-1 truncate text-fg-primary">
                              {task.title}
                            </span>
                            <span className="fd-type-meta max-w-[40%] shrink-0 truncate text-fg-muted">
                              {task.id === selectedThreadId
                                ? "Open now"
                                : projectNames.get(task.workspace_id)}
                            </span>
                            <Check
                              aria-hidden="true"
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 text-accent",
                                !picked && "invisible",
                              )}
                            />
                          </button>
                        );
                      })
                    ) : (
                      <p className="fd-type-meta px-2.5 py-6 text-center text-fg-muted">
                        {query ? "No matching tasks" : "No tasks to promote yet"}
                      </p>
                    )}
                  </div>
                  <p className={HINT_CLASS}>
                    The bot takes over this conversation and keeps its history.
                  </p>
                </div>
              )}
            </div>
          ) : null}
          <Field
            label="Your instructions"
            hint="Added on top of FalconDeck's built-in coordinator behaviour."
          >
            {(id) => (
              <Textarea
                id={id}
                rows={bot ? 6 : 5}
                className="min-h-[7.5rem] resize-y px-3 py-2.5 leading-relaxed"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="What should this bot look after, and how should it work with you?"
              />
            )}
          </Field>
          <details className="group/defaults -mt-2 rounded-[var(--fd-radius-lg)] border border-border-subtle">
            <summary className="fd-focus flex cursor-pointer list-none items-center gap-1.5 rounded-[var(--fd-radius-lg)] px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted hover:text-fg-secondary [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden="true"
                className="h-3 w-3 transition-transform duration-[var(--fd-duration-fast)] group-open/defaults:rotate-90"
              />
              What FalconDeck already tells every bot
            </summary>
            <p className="px-3 pb-3 pl-[1.875rem] text-[length:var(--fd-text-xs)] leading-relaxed text-fg-tertiary">
              Coordinate work through tasks in the appropriate project. Stay
              available for direction, follow up on delegated work, and bring
              back results or decisions. Message other bots and tasks only when
              something needs action. Keep current work in STATUS.md and lasting
              knowledge in MEMORY.md, and read other bots&apos; status instead of
              asking. Respect your edits and deletions. Existing approval rules
              apply.
            </p>
          </details>
          {bot ? (
            <>
              {icon ? <BotIconPicker icon={icon} onChange={setIcon} /> : null}
              <EditorSection title="Permissions">
                <div
                  className="flex cursor-pointer items-start justify-between gap-4"
                  onClick={() => setCanStart((value) => !value)}
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary"
                    >
                      Allow this bot to start tasks
                    </p>
                    <p className={HINT_CLASS}>
                      When off, the bot can plan and advise but asks you to
                      start work yourself.
                    </p>
                  </div>
                  <Switch
                    checked={canStart}
                    onCheckedChange={setCanStart}
                    label="Allow this bot to start tasks"
                    className="mt-0.5"
                  />
                </div>
              </EditorSection>
              <BotContextFiles
                bot={bot}
                api={api}
                files={contextFiles}
                onChange={setContextFiles}
              />
              <BotDocuments bot={bot} api={api} />
              <EditorSection
                title={`Delegated tasks${children.length ? ` · ${children.length}` : ""}`}
              >
                {children.length ? (
                  <div className="-mx-2">
                    {children.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => {
                          onClose();
                          onSelectThread(task.workspace_id, task.id);
                        }}
                        className="fd-focus flex w-full items-center gap-3 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left transition-colors hover:bg-interactive-hover"
                      >
                        <ProviderIcon
                          provider={task.provider}
                          className="text-fg-muted"
                        />
                        <span className="fd-type-supporting min-w-0 flex-1 truncate text-fg-secondary">
                          {task.title}
                        </span>
                        <TaskStatus status={task.status} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className={HINT_CLASS}>
                    Tasks this bot starts will appear here.
                  </p>
                )}
              </EditorSection>
            </>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="rounded-[var(--fd-radius-md)] bg-danger-muted px-3 py-2 text-[length:var(--fd-text-sm)] text-danger"
            >
              {error}
            </p>
          ) : null}
        </div>
        <footer className="flex items-center gap-2 border-t border-border-subtle bg-surface-1 px-6 py-3.5">
          {confirmDelete && bot ? (
            <>
              <p className="min-w-0 flex-1 text-[length:var(--fd-text-sm)] text-fg-secondary">
                Remove this bot? Its conversation is archived and its documents
                stay on disk.
              </p>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await api.mutateBot({ action: "delete", id: bot.id });
                    onClose();
                  })
                }
              >
                Remove bot
              </Button>
            </>
          ) : (
            <>
              {bot ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
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
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    className="text-danger hover:bg-danger-muted hover:text-danger"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete bot
                  </Button>
                </>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={onClose}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSubmit}>
                  {pending ? "Saving…" : bot ? "Save changes" : "Create bot"}
                </Button>
              </div>
            </>
          )}
        </footer>
      </form>
    </div>,
    document.body,
  );
}

/** Shape and color choice for a bot's sidebar mark. */
function BotIconPicker({
  icon,
  onChange,
}: {
  icon: BotIcon;
  onChange: (icon: BotIcon) => void;
}) {
  const option =
    "fd-focus flex h-7 w-7 items-center justify-center rounded-[var(--fd-radius-md)] border transition-colors";
  return (
    <EditorSection title="Icon">
      <div role="radiogroup" aria-label="Shape" className="flex flex-wrap gap-1.5">
        {BOT_ICON_SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            role="radio"
            aria-checked={icon.shape === shape}
            aria-label={shape}
            title={shape}
            onClick={() => onChange({ ...icon, shape })}
            className={cn(
              option,
              icon.shape === shape
                ? "border-border-emphasis bg-surface-3"
                : "border-transparent hover:bg-interactive-hover",
            )}
          >
            <BotMark icon={{ ...icon, shape }} size={14} />
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5">
        {BOT_ICON_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={icon.color === color}
            aria-label={`Color ${color.replace("cat-", "")}`}
            onClick={() => onChange({ ...icon, color })}
            className={cn(
              "fd-focus h-6 w-6 rounded-full border-2 transition-transform",
              icon.color === color
                ? "scale-110 border-fg-primary"
                : "border-transparent hover:scale-105",
            )}
            style={{ backgroundColor: workspaceColorCssVar(color) }}
          />
        ))}
      </div>
    </EditorSection>
  );
}

function formatTokens(tokens: number) {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function fileName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** Text files read fresh into each of this bot's turns, with size estimates. */
function BotContextFiles({
  bot,
  api,
  files,
  onChange,
}: {
  bot: BotProfile;
  api: BotApi;
  files: string[];
  onChange: (files: string[]) => void;
}) {
  const [list, setList] = useState<ContextFileList | null>(null);
  const [report, setReport] = useState<BotContextReport | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [adding, setAdding] = useState<"new" | "path" | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<ContextFileContent | null>(null);
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const saved = bot.context_files ?? [];
  const dirty = files.join("\n") !== saved.join("\n");
  const load = useCallback(async () => {
    if (!api.contextFiles || !api.botContext) throw new Error("unsupported");
    const [nextList, nextReport] = await Promise.all([
      api.contextFiles(),
      api.botContext(bot.id),
    ]);
    setList(nextList);
    setReport(nextReport);
  }, [api, bot.id]);
  useEffect(() => {
    let active = true;
    // Older daemons lack these endpoints; hide the section rather than erroring.
    load().catch(() => {
      if (active) setUnsupported(true);
    });
    return () => {
      active = false;
    };
  }, [load]);
  if (unsupported) return null;
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const open = (file: ContextFileContent) => {
    setEditing(file);
    setContent(file.content);
    requestAnimationFrame(() =>
      editor.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }),
    );
  };
  const attach = (path: string) => {
    if (!files.includes(path)) onChange([...files, path]);
  };
  const submitDraft = () => {
    const value = draft.trim();
    if (!value || pending) return;
    if (adding === "path") {
      attach(value);
      setAdding(null);
      return;
    }
    void run(async () => {
      const created = await api.writeContextFile!({
        name: value,
        content: `# ${value.replace(/\.[^.]+$/, "")}\n\n`,
      });
      attach(created.path);
      setAdding(null);
      open(created);
      await load();
    });
  };
  const sections = new Map(
    report?.sections.flatMap((section) =>
      section.path ? [[section.path, section]] : [],
    ),
  );
  const known = new Map(list?.files.map((file) => [file.path, file]));
  const suggestions = list?.files.filter((file) => !files.includes(file.path)) ?? [];
  return (
    <EditorSection
      title="Context in every turn"
      actions={
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setAdding("path");
              setDraft("");
            }}
          >
            <FolderPlus aria-hidden="true" className="h-3.5 w-3.5" />
            Add path
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setAdding("new");
              setDraft("COMPANY.md");
            }}
          >
            <FilePlus2 aria-hidden="true" className="h-3.5 w-3.5" />
            New file
          </Button>
        </>
      }
    >
      <p className={HINT_CLASS}>
        Read fresh from disk into each of this bot&apos;s turns. Tasks it starts
        don&apos;t get them; the bot briefs them instead.
      </p>
      {files.length ? (
        <div className="-mx-2">
          {files.map((path) => {
            const section = sections.get(path);
            const tokens = section?.tokens ?? known.get(path)?.tokens;
            const where = known.get(path)?.location ?? path;
            return (
              <div
                key={path}
                className={cn(
                  "group/context flex items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2 py-1.5",
                  editing?.path === path && "bg-interactive-selected",
                )}
              >
                <FileText
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-fg-muted"
                />
                <button
                  type="button"
                  disabled={pending}
                  title={path}
                  onClick={() =>
                    void run(async () => open(await api.readContextFile!(path)))
                  }
                  className="fd-focus min-w-0 flex-1 truncate rounded-[var(--fd-radius-sm)] text-left disabled:opacity-60"
                >
                  <span className="fd-type-supporting text-fg-secondary">
                    {fileName(path)}
                  </span>
                  <span className="ml-2 text-[length:var(--fd-text-2xs)] text-fg-muted">
                    {where}
                  </span>
                </button>
                {section?.error ? (
                  <span className="shrink-0 text-[length:var(--fd-text-2xs)] text-danger">
                    {section.error}
                  </span>
                ) : tokens !== undefined ? (
                  <span className="fd-type-mono shrink-0 text-[length:var(--fd-text-2xs)] text-fg-muted">
                    ≈{formatTokens(tokens)}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove ${fileName(path)}`}
                  disabled={pending}
                  onClick={() => onChange(files.filter((file) => file !== path))}
                  className={SECTION_ICON_BUTTON_CLASS}
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {suggestions.length ? (
        <Select value="" onValueChange={attach}>
          <SelectTrigger
            aria-label="Add a context file"
            className="h-9 w-full rounded-[var(--fd-radius-lg)] bg-surface-2 text-[length:var(--fd-text-sm)] text-fg-muted"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
              <SelectValue placeholder="Add a file from FalconDeck or a project" />
            </span>
          </SelectTrigger>
          <SelectContent>
            {suggestions.map((file) => (
              <SelectItem key={file.path} value={file.path}>
                {file.location} / {file.name} · ≈{formatTokens(file.tokens)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {adding ? (
        <div className="flex items-center gap-2">
          <Input
            aria-label={adding === "path" ? "File path" : "New file name"}
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // Keep Enter from submitting the surrounding bot form.
              event.preventDefault();
              submitDraft();
            }}
            placeholder={
              adding === "path" ? "/Users/you/project/METRICS.md" : "COMPANY.md"
            }
            className="fd-type-mono h-9 flex-1 text-[length:var(--fd-text-xs)]"
          />
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending || !draft.trim()}
            onClick={submitDraft}
          >
            {adding === "path" ? "Add" : "Create"}
          </Button>
        </div>
      ) : null}
      {adding === "new" && list ? (
        <p className={HINT_CLASS}>Created in {list.folder}</p>
      ) : null}
      {editing ? (
        <div
          ref={editor}
          className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2"
        >
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
              {fileName(editing.path)}
            </span>
            <span
              className="fd-type-mono min-w-0 flex-1 truncate text-[length:var(--fd-text-2xs)] text-fg-muted"
              title={editing.path}
            >
              {editing.path}
            </span>
            <CopyButton text={editing.path} label="Copy file path" />
          </div>
          <Textarea
            aria-label="Context file content"
            rows={10}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="fd-type-mono resize-y rounded-none border-0 bg-transparent px-3 py-2.5 text-[length:var(--fd-text-xs)] leading-relaxed"
          />
          <div className="flex items-center gap-2 border-t border-border-subtle px-2 py-2">
            <span className="fd-type-mono px-1 text-[length:var(--fd-text-2xs)] text-fg-muted">
              ≈{formatTokens(Math.ceil(content.length / 4))} tokens
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setEditing(null)}
              >
                Close
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending || content === editing.content}
                onClick={() =>
                  void run(async () => {
                    setEditing(
                      await api.writeContextFile!({
                        path: editing.path,
                        content,
                        expected_version: editing.version,
                      }),
                    );
                    await load();
                  })
                }
              >
                Save file
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {report ? (
        <details className="group/budget rounded-[var(--fd-radius-lg)] border border-border-subtle">
          <summary className="fd-focus flex cursor-pointer list-none items-center gap-1.5 rounded-[var(--fd-radius-lg)] px-3 py-2 text-[length:var(--fd-text-xs)] text-fg-muted hover:text-fg-secondary [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="h-3 w-3 transition-transform duration-[var(--fd-duration-fast)] group-open/budget:rotate-90"
            />
            <span className="flex-1">
              ≈{formatTokens(report.total_tokens)} tokens added to every turn
            </span>
            {dirty ? <span>Save to update</span> : null}
          </summary>
          <div className="space-y-3 px-3 pb-3 pl-[1.875rem]">
            <dl className="space-y-1 text-[length:var(--fd-text-xs)]">
              {report.sections.map((section, index) => (
                <div key={index} className="flex gap-3">
                  <dt className="min-w-0 flex-1 truncate text-fg-secondary">
                    {section.label}
                  </dt>
                  <dd className="fd-type-mono text-fg-muted">
                    ≈{formatTokens(section.tokens)}
                  </dd>
                </div>
              ))}
            </dl>
            <pre className="fd-type-mono max-h-64 overflow-auto whitespace-pre-wrap rounded-[var(--fd-radius-md)] bg-surface-2 p-2.5 text-[length:var(--fd-text-2xs)] leading-relaxed text-fg-tertiary">
              {report.text}
            </pre>
          </div>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="text-[length:var(--fd-text-sm)] text-danger">
          {error}
        </p>
      ) : null}
    </EditorSection>
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
  const upload = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    void api.botDocuments(bot.id).then(
      (files) => {
        if (active) setFiles(files);
      },
      (error) => {
        if (active) setError(errorMessage(error));
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
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const open = (next: string, body: string, from: typeof original) => {
    setName(next);
    setContent(body);
    setOriginal(from);
    setDeleting(false);
    requestAnimationFrame(() =>
      editor.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }),
    );
  };
  return (
    <EditorSection
      title="Documents"
      actions={
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => upload.current?.click()}
          >
            <Upload aria-hidden="true" className="h-3.5 w-3.5" />
            Upload
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => open("Untitled.md", "", null)}
          >
            <FilePlus2 aria-hidden="true" className="h-3.5 w-3.5" />
            New document
          </Button>
        </>
      }
    >
      <input
        ref={upload}
        aria-label="Add document"
        type="file"
        accept=".md,.txt,.json,.csv,.yaml,.yml"
        disabled={pending}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (file.size > 1_048_576) {
            setError("Document must be at most 1 MB");
            return;
          }
          void run(async () => open(file.name, await file.text(), null));
        }}
      />
      <div className="flex items-center gap-1.5">
        <p
          className="fd-type-mono min-w-0 flex-1 truncate text-[length:var(--fd-text-2xs)] text-fg-muted"
          title={bot.space_path}
        >
          {bot.space_path}
        </p>
        <CopyButton text={bot.space_path} label="Copy folder path" />
      </div>
      {files.length ? (
        <div className="-mx-2">
          {files.map((file) => (
            <button
              key={file}
              type="button"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  const doc = await api.readBotDocument(bot.id, file);
                  open(doc.name, doc.content, {
                    name: doc.name,
                    version: doc.version,
                  });
                })
              }
              className={cn(
                "fd-focus flex w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left transition-colors hover:bg-interactive-hover disabled:opacity-60",
                original?.name === file && name && "bg-interactive-selected",
              )}
            >
              <FileText
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-fg-muted"
              />
              <span className="fd-type-supporting min-w-0 flex-1 truncate text-fg-secondary">
                {file}
              </span>
            </button>
          ))}
        </div>
      ) : !name ? (
        <p className={HINT_CLASS}>
          Notes, priorities and reference material the bot reads and keeps up
          to date.
        </p>
      ) : null}
      {name ? (
        <div
          ref={editor}
          className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2">
          <Input
            aria-label="Document name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-10 rounded-none border-0 border-b border-border-subtle bg-transparent font-medium"
          />
          <Textarea
            aria-label="Document content"
            rows={9}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="fd-type-mono resize-y rounded-none border-0 bg-transparent px-3 py-2.5 text-[length:var(--fd-text-xs)] leading-relaxed"
          />
          <div className="flex items-center gap-2 border-t border-border-subtle px-2 py-2">
            {deleting ? (
              <>
                <p className="min-w-0 flex-1 px-1 text-[length:var(--fd-text-xs)] text-fg-secondary">
                  Delete {name} from disk?
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleting(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
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
              </>
            ) : (
              <>
                {original?.name === name ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    className="text-danger hover:bg-danger-muted hover:text-danger"
                    onClick={() => setDeleting(true)}
                  >
                    Delete document
                  </Button>
                ) : null}
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setName("")}
                  >
                    Discard
                  </Button>
                  <Button
                    type="button"
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
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[length:var(--fd-text-sm)] text-danger">
          {error}
        </p>
      ) : null}
    </EditorSection>
  );
}
