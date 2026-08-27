import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";

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

type CardDrag = {
  pointerId: number;
  threadId: string;
  title: string;
  startX: number;
  startY: number;
  active: boolean;
  dropStageId: string | null;
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

// HTML5 drag-and-drop does not deliver drop events in the Tauri webview.
const CARD_DRAG_THRESHOLD_PX = 4;
// Staged cards always render; the unstaged inbox would otherwise grow one
// card per session forever, so it only surfaces recent activity.
const UNSTAGED_MAX_AGE_DAYS = 7;
const UNSTAGED_MAX_CARDS = 100;
const PROJECT_FILTER_STORAGE_KEY = "falcondeck.kanban.project-filter";

function byRecency(
  a: ExtensionAppThreadSummary,
  b: ExtensionAppThreadSummary,
): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

function readStoredProjectFilter(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_FILTER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function stageIdAtPoint(
  columns: Map<string, HTMLElement>,
  clientX: number,
  clientY: number,
): string | null {
  for (const [stageId, node] of columns) {
    const rect = node.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return stageId;
    }
  }
  return null;
}

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
  workspaces = [],
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
  const [dragging, setDragging] = useState<{
    threadId: string;
    title: string;
  } | null>(null);
  const [dropStageId, setDropStageId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const dragRef = useRef<CardDrag | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef(new Map<string, HTMLElement>());
  const suppressThreadOpenRef = useRef(false);
  const [projectFilter, setProjectFilter] = useState<string | null>(
    readStoredProjectFilter,
  );
  const canReadThreads = hasPermission("threads:read");

  const selectProject = useCallback((workspaceId: string | null) => {
    setProjectFilter(workspaceId);
    try {
      if (workspaceId) {
        window.localStorage.setItem(PROJECT_FILTER_STORAGE_KEY, workspaceId);
      } else {
        window.localStorage.removeItem(PROJECT_FILTER_STORAGE_KEY);
      }
    } catch {
      // Storage failures only lose persistence, not the in-session filter.
    }
  }, []);

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
  const projectOptions = useMemo(() => {
    const threadCounts = new Map<string, number>();
    for (const thread of threads) {
      threadCounts.set(
        thread.workspaceId,
        (threadCounts.get(thread.workspaceId) ?? 0) + 1,
      );
    }
    return workspaces.filter((workspace) => threadCounts.has(workspace.id));
  }, [threads, workspaces]);
  const activeProject = useMemo(
    () =>
      projectFilter &&
      projectOptions.some((workspace) => workspace.id === projectFilter)
        ? projectFilter
        : null,
    [projectFilter, projectOptions],
  );
  const { threadsByStage, hiddenUnstagedCount } = useMemo(() => {
    const grouped = new Map<string, ExtensionAppThreadSummary[]>();
    for (const column of columns) grouped.set(column.id, []);
    const visible = activeProject
      ? threads.filter((thread) => thread.workspaceId === activeProject)
      : threads;
    const unstaged: ExtensionAppThreadSummary[] = [];
    for (const thread of visible) {
      const stageId = board.threadStages[thread.id] ?? "";
      if (stageId && grouped.has(stageId)) grouped.get(stageId)?.push(thread);
      else unstaged.push(thread);
    }
    for (const list of grouped.values()) list.sort(byRecency);
    unstaged.sort(byRecency);
    const cutoff = Date.now() - UNSTAGED_MAX_AGE_DAYS * 86_400_000;
    const recent = unstaged
      .slice(0, UNSTAGED_MAX_CARDS)
      .filter((thread) => (Date.parse(thread.updatedAt) || 0) >= cutoff);
    grouped.set("", recent);
    return {
      threadsByStage: grouped,
      hiddenUnstagedCount: unstaged.length - recent.length,
    };
  }, [activeProject, board.threadStages, columns, threads]);

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

  const handleCardPointerDown = useCallback(
    (
      thread: ExtensionAppThreadSummary,
      event: PointerEvent<HTMLButtonElement>,
    ) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      dragRef.current = {
        pointerId: event.pointerId,
        threadId: thread.id,
        title: thread.title || "Untitled thread",
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        dropStageId: null,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handleCardPointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (!drag.active) {
        if (distance < CARD_DRAG_THRESHOLD_PX) return;
        drag.active = true;
        suppressThreadOpenRef.current = true;
        setDragging({ threadId: drag.threadId, title: drag.title });
        setDragPosition({ x: event.clientX, y: event.clientY });
      } else if (ghostRef.current) {
        ghostRef.current.style.left = `${event.clientX + 12}px`;
        ghostRef.current.style.top = `${event.clientY + 12}px`;
      }
      event.preventDefault();
      const nextStageId = stageIdAtPoint(
        columnRefs.current,
        event.clientX,
        event.clientY,
      );
      if (drag.dropStageId === nextStageId) return;
      drag.dropStageId = nextStageId;
      setDropStageId(nextStageId);
    },
    [],
  );

  const finishCardDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      dragRef.current = null;
      setDragging(null);
      setDropStageId(null);
      setDragPosition(null);
      if (!drag.active) return;
      window.setTimeout(() => {
        suppressThreadOpenRef.current = false;
      }, 0);
      if (drag.dropStageId === null) return;
      void moveThread(drag.threadId, drag.dropStageId);
    },
    [moveThread],
  );

  const handleCardClickCapture = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!suppressThreadOpenRef.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
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
      {projectOptions.length > 1 ? (
        <div
          role="toolbar"
          aria-label="Filter by project"
          className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-5 py-2.5"
        >
          <button
            type="button"
            aria-pressed={activeProject === null}
            onClick={() => selectProject(null)}
            className={`fd-focus rounded-full border px-3 py-1 text-[length:var(--fd-text-xs)] font-medium transition-colors ${
              activeProject === null
                ? "border-accent bg-accent/10 text-accent"
                : "border-border-subtle text-fg-secondary hover:border-border-default hover:text-fg-primary"
            }`}
          >
            All projects
          </button>
          {projectOptions.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              aria-pressed={activeProject === workspace.id}
              onClick={() =>
                selectProject(
                  activeProject === workspace.id ? null : workspace.id,
                )
              }
              className={`fd-focus max-w-48 truncate rounded-full border px-3 py-1 text-[length:var(--fd-text-xs)] font-medium transition-colors ${
                activeProject === workspace.id
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border-subtle text-fg-secondary hover:border-border-default hover:text-fg-primary"
              }`}
            >
              {workspace.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-5">
        <div className="flex h-full min-w-max gap-4">
          {columns.map((column) => {
            const columnThreads = threadsByStage.get(column.id) ?? [];
            const isDropTarget =
              dragging != null && dropStageId === column.id;
            return (
              <section
                key={column.id}
                ref={(node) => {
                  if (node) columnRefs.current.set(column.id, node);
                  else columnRefs.current.delete(column.id);
                }}
                aria-label={column.label}
                data-kanban-drop-active={isDropTarget ? "true" : undefined}
                className={`flex h-full w-72 flex-col rounded-[var(--fd-radius-lg)] border bg-surface-1 ${
                  isDropTarget
                    ? "border-accent"
                    : "border-border-subtle"
                }`}
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
                  {columnThreads.map((thread) => {
                    const isDragged = dragging?.threadId === thread.id;
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        aria-grabbed={isDragged ? true : undefined}
                        onPointerDown={(event) =>
                          handleCardPointerDown(thread, event)
                        }
                        onPointerMove={handleCardPointerMove}
                        onPointerUp={finishCardDrag}
                        onPointerCancel={finishCardDrag}
                        onClickCapture={handleCardClickCapture}
                        onDragStart={(event) => event.preventDefault()}
                        onClick={() =>
                          openThread(thread.workspaceId, thread.id)
                        }
                        style={{ touchAction: "none" }}
                        className={`fd-focus w-full cursor-grab select-none rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 p-3 text-left shadow-sm transition-colors hover:border-border-default hover:bg-surface-3 active:cursor-grabbing ${
                          isDragged ? "cursor-grabbing opacity-50" : ""
                        }`}
                      >
                        <span className="line-clamp-2 text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                          {thread.title || "Untitled thread"}
                        </span>
                        <span className="mt-2 block text-[length:var(--fd-text-xs)] capitalize text-fg-muted">
                          {thread.status.replaceAll("_", " ")}
                        </span>
                      </button>
                    );
                  })}
                  {column.id === "" && hiddenUnstagedCount > 0 ? (
                    <p className="px-1 pb-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                      {hiddenUnstagedCount} older{" "}
                      {hiddenUnstagedCount === 1 ? "thread" : "threads"} hidden
                      — move a card to a stage to keep it on the board
                    </p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {dragging && dragPosition
        ? createPortal(
            <div
              ref={ghostRef}
              aria-hidden="true"
              className="pointer-events-none fixed z-[100] max-w-64 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-3 py-2 text-[length:var(--fd-text-sm)] font-medium text-fg-primary shadow-[var(--fd-shadow-lg)]"
              style={{
                left: dragPosition.x + 12,
                top: dragPosition.y + 12,
              }}
            >
              <span className="line-clamp-2">{dragging.title}</span>
            </div>,
            document.body,
          )
        : null}
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
