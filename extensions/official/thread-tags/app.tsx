import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react";

import {
  defineExtensionApp,
  type ExtensionAppPanelProps,
  type ExtensionAppThreadSummary,
} from "@falcondeck/extension-sdk/app";

type Stage = {
  id: string;
  label: string;
  color: string;
};

type BoardState = {
  stages: Stage[];
  threadStages: Record<string, string>;
};

const COLOR_CLASSES: Record<string, string> = {
  gray: "bg-fg-muted",
  red: "bg-danger",
  orange: "bg-warning",
  yellow: "bg-warning",
  green: "bg-success",
  blue: "bg-info",
  purple: "bg-accent",
  pink: "bg-accent",
};

function parseStageCatalog(value: unknown): Stage[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return [];
    }
    const stage = candidate as Record<string, unknown>;
    return typeof stage.id === "string" &&
      typeof stage.label === "string" &&
      typeof stage.color === "string"
      ? [{ id: stage.id, label: stage.label, color: stage.color }]
      : [];
  });
}

function parseBoardState(value: unknown): BoardState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kanban returned an invalid board response");
  }
  const record = value as Record<string, unknown>;
  const stages = parseStageCatalog(record.stages);
  if (!stages) {
    throw new Error("Kanban returned an invalid stage catalog");
  }
  const threadStages =
    record.threadStages &&
    typeof record.threadStages === "object" &&
    !Array.isArray(record.threadStages)
      ? Object.fromEntries(
          Object.entries(record.threadStages).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  return { stages, threadStages };
}

function KanbanBoard({
  threads,
  views,
  hasPermission,
  invokeAction,
  openThread,
}: ExtensionAppPanelProps) {
  const [board, setBoard] = useState<BoardState>({
    stages: [],
    threadStages: {},
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canReadThreads = hasPermission("threads:read");

  useEffect(() => {
    if (!canReadThreads) {
      setLoading(false);
      return;
    }
    let active = true;
    void invokeAction("manage-tags", { operation: "read" })
      .then((response) => {
        if (!active) return;
        setBoard(parseBoardState(response.result));
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error ? reason.message : "Could not load Kanban",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canReadThreads, invokeAction]);

  useEffect(() => {
    const publishedCatalog = views.find(
      (view) => view.viewId === "tag-index" && !view.scope,
    );
    const catalogValue =
      publishedCatalog?.value &&
      typeof publishedCatalog.value === "object" &&
      !Array.isArray(publishedCatalog.value)
        ? (publishedCatalog.value as Record<string, unknown>).tags
        : null;
    const publishedStages = parseStageCatalog(catalogValue);
    const publishedAssignments = views.flatMap((view) => {
      if (view.viewId !== "thread-tags" || view.scope?.kind !== "thread") {
        return [];
      }
      const value = view.value;
      if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
      const tagIds = (value as Record<string, unknown>).tagIds;
      const stageId =
        Array.isArray(tagIds) && typeof tagIds[0] === "string"
          ? tagIds[0]
          : null;
      return [{ threadId: view.scope.id, stageId }];
    });
    if (!publishedStages && publishedAssignments.length === 0) return;
    setBoard((current) => {
      const threadStages = { ...current.threadStages };
      for (const assignment of publishedAssignments) {
        if (assignment.stageId)
          threadStages[assignment.threadId] = assignment.stageId;
        else delete threadStages[assignment.threadId];
      }
      return {
        stages: publishedStages ?? current.stages,
        threadStages,
      };
    });
  }, [views]);

  const columns = useMemo(
    () => [{ id: "", label: "No stage", color: "gray" }, ...board.stages],
    [board.stages],
  );
  const threadsByStage = useMemo(() => {
    const grouped = new Map<string, ExtensionAppThreadSummary[]>();
    for (const column of columns) grouped.set(column.id, []);
    for (const thread of threads) {
      const stageId = board.threadStages[thread.id] ?? "";
      const target = grouped.has(stageId) ? stageId : "";
      grouped.get(target)?.push(thread);
    }
    return grouped;
  }, [board.threadStages, columns, threads]);

  const moveThread = useCallback(
    async (threadId: string, stageId: string) => {
      const previous = board.threadStages[threadId] ?? "";
      if (previous === stageId) return;
      setBoard((current) => {
        const threadStages = { ...current.threadStages };
        if (stageId) threadStages[threadId] = stageId;
        else delete threadStages[threadId];
        return { ...current, threadStages };
      });
      try {
        await invokeAction(
          "manage-tags",
          { operation: "set_thread_stage", stageId: stageId || null },
          { kind: "thread", id: threadId },
        );
        setError(null);
      } catch (reason) {
        setBoard((current) => {
          const threadStages = { ...current.threadStages };
          if (previous) threadStages[threadId] = previous;
          else delete threadStages[threadId];
          return { ...current, threadStages };
        });
        setError(
          reason instanceof Error ? reason.message : "Could not move thread",
        );
      }
    },
    [board.threadStages, invokeAction],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>, stageId: string) => {
      event.preventDefault();
      const threadId = event.dataTransfer.getData(
        "application/x-falcondeck-thread",
      );
      if (threadId) void moveThread(threadId, stageId);
    },
    [moveThread],
  );

  if (!canReadThreads) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 p-6 text-center">
          <h2 className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
            Allow thread summaries to use Kanban
          </h2>
          <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
            Open Extensions, select Kanban, and grant thread summary access.
            Message content and filesystem paths are never shared with the
            extension.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="p-6 text-fg-muted">Loading Kanban…</div>;
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
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-5">
        <div className="flex h-full min-w-max gap-4">
          {columns.map((column) => {
            const columnThreads = threadsByStage.get(column.id) ?? [];
            return (
              <section
                key={column.id}
                aria-label={column.label}
                className="flex h-full w-72 flex-col rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleDrop(event, column.id)}
              >
                <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-3">
                  <span
                    aria-hidden="true"
                    className={`h-2.5 w-2.5 rounded-full ${COLOR_CLASSES[column.color] ?? COLOR_CLASSES.gray}`}
                  />
                  <h2 className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">
                    {column.label}
                  </h2>
                  <span className="text-[length:var(--fd-text-xs)] tabular-nums text-fg-muted">
                    {columnThreads.length}
                  </span>
                </header>
                <div className="min-h-24 flex-1 space-y-2 overflow-y-auto p-2">
                  {columnThreads.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData(
                          "application/x-falcondeck-thread",
                          thread.id,
                        );
                      }}
                      onClick={() => openThread(thread.workspaceId, thread.id)}
                      className="fd-focus w-full rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 p-3 text-left shadow-sm transition-colors hover:border-border-default hover:bg-surface-3"
                    >
                      <span className="line-clamp-2 text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                        {thread.title || "Untitled thread"}
                      </span>
                      <span className="mt-2 block text-[length:var(--fd-text-xs)] capitalize text-fg-muted">
                        {thread.status.replaceAll("_", " ")}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default defineExtensionApp("falcondeck.thread-tags", (app) => {
  app.panels.register({
    id: "board",
    title: "Kanban",
    icon: "kanban",
    component: KanbanBoard,
  });
});
