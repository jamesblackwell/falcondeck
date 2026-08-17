import * as React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  FolderClosed,
  FolderPlus,
  Plus,
  Search,
} from "lucide-react";

import {
  compareThreads,
  filterProjectGroupsByExtensions,
  THREAD_TAGS_EXTENSION_ID,
  threadModelLabel,
  threadPriorityRank,
} from "@falcondeck/client-core";
import type {
  ActiveExtensionThreadFilter,
  ExtensionSidebarFilterDefinition,
  ExtensionSnapshot,
  ProjectGroup,
  ThreadSortMode,
  ThreadSummary,
  ThreadTag,
} from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Button,
  EmptyState,
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarHeader,
  cn,
} from "@falcondeck/ui";

import { AttentionInbox } from "./attention-inbox";
import { ExtensionSidebarFilters } from "./extension-sidebar-filters";
import { ThreadStageFilterMenu } from "./thread-stage-filter-menu";
import { ThreadSortMenu } from "./thread-sort-menu";
import {
  AddThreadStageDialog,
  DeleteThreadDialog,
  RemoveWorkspaceDialog,
  RenameThreadDialog,
  ThreadContextMenu,
  WorkspaceContextMenu,
  type ThreadContextMenuState,
  type WorkspaceContextMenuState,
} from "./sidebar-menus";
import { ThreadItem, type ThreadItemArchiveHandler } from "./thread-item";
import { WorkspaceGroup, type WorkspaceHostBadge } from "./workspace-group";

const VISIBLE_THREAD_LIMIT = 5;
const SHOW_MORE_STEP = 10;
const THREAD_PAGER_BUTTON_CLASS =
  "fd-focus flex items-center gap-1.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary";
const RELATIVE_TIME_TICK_MS = 60_000;
const OPTIMISTIC_SELECTION_TTL_MS = 1_500;
const WORKSPACE_DRAG_THRESHOLD_PX = 4;
const PRIORITY_THREAD_COMPARATOR = compareThreads("priority");

type SidebarEmptyState = {
  title: string;
  description?: string;
};

export type WorkspaceSidebarProps = {
  groups: ProjectGroup[];
  // Host badges for workspaces that live on enrolled remote servers,
  // keyed by workspace id.
  workspaceHosts?: Record<string, WorkspaceHostBadge>;
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
  onSelectWorkspace: (workspaceId: string, threadId: string | null) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onNewThread?: (workspaceId: string) => void;
  onArchiveThread?: ThreadItemArchiveHandler;
  /** Permanent, unlike archive: also removes a variant thread's checkout. */
  onDeleteThread?: (
    workspaceId: string,
    threadId: string,
  ) => Promise<void> | void;
  onRenameThread?: (
    workspaceId: string,
    threadId: string,
    title: string,
  ) => Promise<void> | void;
  onTogglePinThread?: (
    workspaceId: string,
    threadId: string,
    pinned: boolean,
  ) => Promise<void> | void;
  onMarkThreadRead?: (
    workspaceId: string,
    threadId: string,
  ) => Promise<void> | void;
  onMarkThreadUnread?: (
    workspaceId: string,
    threadId: string,
  ) => Promise<void> | void;
  onAddProject?: () => void;
  /** Opens the host's command palette from the sidebar header. */
  onSearch?: () => void;
  /** Rendered shortcuts ("⌘N") appended to the header tooltips, when the host binds them. */
  newThreadShortcut?: string;
  addProjectShortcut?: string;
  searchShortcut?: string;
  onRemoveWorkspace?: (workspaceId: string) => Promise<void> | void;
  /** How chats order within each project; also applies to the pinned list. */
  threadSort?: ThreadSortMode;
  /** Enables the sort menu on the Projects heading. */
  onThreadSortChange?: (mode: ThreadSortMode) => void;
  /** Called with the new project order after a drag completes. */
  onWorkspaceOrderChange?: (workspaceIds: string[]) => Promise<void> | void;
  /** Projects the host wants rendered collapsed. */
  collapsedWorkspaceIds?: readonly string[];
  onWorkspaceCollapsedChange?: (
    workspaceId: string,
    collapsed: boolean,
  ) => void;
  isAddingProject?: boolean;
  title?: string;
  errors?: string[];
  emptyState?: SidebarEmptyState;
  footer?: React.ReactNode;
  /** First-class navigation rendered before pinned threads and projects. */
  topNavigation?: React.ReactNode;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  threadTagsById?: Record<string, ThreadTag[]>;
  threadTagOptions?: ThreadTag[];
  onSetThreadStage?: (
    workspaceId: string,
    thread: ThreadSummary,
    stage: ThreadTag | null,
  ) => Promise<void> | void;
  canSetThreadStage?: (workspaceId: string) => boolean;
  onCreateThreadStage?: (
    workspaceId: string,
    thread: ThreadSummary,
    label: string,
  ) => Promise<void> | void;
  /** Generic manifest-declared sidebar filters rendered from extension UI v1. */
  extensionSidebarFilters?: ExtensionSidebarFilterDefinition[];
  /** Synchronized projections inspected by declarative filter bindings. */
  extensionSnapshot?: ExtensionSnapshot | null;
};

type PriorityQueueState = {
  bucket: number;
  order: number;
};

const summaryKey = (thread: ThreadSummary) => thread.id;
const summaryThread = (thread: ThreadSummary) => thread;

/**
 * Keeps Priority useful as a work queue instead of a live activity sort.
 * Promotions apply immediately; demotions wait for the next navigation so a
 * selected row cannot jump when opening it marks it read.
 */
function useStablePriorityOrder<Item>(
  items: Item[],
  selectedThreadId: string | null,
  active: boolean,
  keyFor: (item: Item) => string,
  threadFor: (item: Item) => ThreadSummary,
) {
  const queueRef = useRef(new Map<string, PriorityQueueState>());
  const previousSelectionRef = useRef(selectedThreadId);
  const wasActiveRef = useRef(false);
  const nextFrontOrderRef = useRef(-1);

  return useMemo(() => {
    if (!active) {
      wasActiveRef.current = false;
      return items;
    }

    const enteringPriority = !wasActiveRef.current;
    const navigated = previousSelectionRef.current !== selectedThreadId;
    wasActiveRef.current = true;
    previousSelectionRef.current = selectedThreadId;

    const liveIds = new Set(items.map(keyFor));
    for (const id of queueRef.current.keys()) {
      if (!liveIds.has(id)) queueRef.current.delete(id);
    }

    if (enteringPriority) {
      queueRef.current.clear();
      const seeded = [...items].sort((left, right) =>
        PRIORITY_THREAD_COMPARATOR(threadFor(left), threadFor(right)),
      );
      seeded.forEach((item, order) =>
        queueRef.current.set(keyFor(item), {
          bucket: threadPriorityRank(threadFor(item)),
          order,
        }),
      );
      nextFrontOrderRef.current = -1;
    } else {
      const arrivals = items
        .filter((item) => !queueRef.current.has(keyFor(item)))
        .sort((left, right) =>
          PRIORITY_THREAD_COMPARATOR(threadFor(left), threadFor(right)),
        );
      let arrivalOrder = nextFrontOrderRef.current - arrivals.length + 1;
      for (const item of arrivals) {
        queueRef.current.set(keyFor(item), {
          bucket: threadPriorityRank(threadFor(item)),
          order: arrivalOrder++,
        });
      }
      nextFrontOrderRef.current -= arrivals.length;

      for (const item of items) {
        const desiredBucket = threadPriorityRank(threadFor(item));
        const current = queueRef.current.get(keyFor(item));
        if (current && (desiredBucket < current.bucket || navigated)) {
          current.bucket = desiredBucket;
        }
      }
    }

    return [...items].sort((left, right) => {
      const leftKey = keyFor(left);
      const rightKey = keyFor(right);
      const leftState = queueRef.current.get(leftKey);
      const rightState = queueRef.current.get(rightKey);
      return (
        (leftState?.bucket ?? 4) - (rightState?.bucket ?? 4) ||
        (leftState?.order ?? 0) - (rightState?.order ?? 0) ||
        leftKey.localeCompare(rightKey)
      );
    });
  }, [active, items, keyFor, selectedThreadId, threadFor]);
}

const ThreadList = memo(function ThreadList({
  group,
  sortMode,
  selectedThreadId,
  onSelectThread,
  onArchiveThread,
  onOpenThreadContextMenu,
  onRequestRenameThread,
  nowTick,
  threadTagsById,
}: {
  group: ProjectGroup;
  sortMode: ThreadSortMode;
  selectedThreadId: string | null;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onArchiveThread?: ThreadItemArchiveHandler;
  onOpenThreadContextMenu?: (args: ThreadContextMenuState) => void;
  onRequestRenameThread?: (args: {
    workspaceId: string;
    thread: ThreadSummary;
  }) => void;
  nowTick: number;
  threadTagsById?: Record<string, ThreadTag[]>;
}) {
  const [visibleCount, setVisibleCount] = useState(VISIBLE_THREAD_LIMIT);
  const unpinned = useMemo(
    () => group.threads.filter((thread) => !thread.is_pinned),
    [group.threads],
  );
  const stablePriorityThreads = useStablePriorityOrder(
    unpinned,
    selectedThreadId,
    sortMode === "priority",
    summaryKey,
    summaryThread,
  );
  const unpinnedThreads = useMemo(
    () =>
      sortMode === "priority"
        ? stablePriorityThreads
        : [...unpinned].sort(compareThreads(sortMode)),
    [sortMode, stablePriorityThreads, unpinned],
  );

  const visible = unpinnedThreads.slice(0, visibleCount);
  const hiddenCount = Math.max(0, unpinnedThreads.length - visible.length);
  // The open thread can sit well outside the window (opening a project resumes
  // its last thread, which may be days old). Trail it below the window as a
  // single extra row rather than unrolling every thread above it — the list
  // stays a stable length instead of growing and snapping back as the
  // selection moves.
  const trailingSelected =
    selectedThreadId != null && hiddenCount > 0
      ? (unpinnedThreads
          .slice(visibleCount)
          .find((thread) => thread.id === selectedThreadId) ?? null)
      : null;
  // "Show less" rides alongside "Show more" as soon as the list has grown past
  // its resting length, so a partly-expanded project can be wound back without
  // first paging all the way to the end.
  const canCollapse = visibleCount > VISIBLE_THREAD_LIMIT;

  return (
    <>
      {group.threads.length === 0 ? (
        <p className="py-2 pl-2.5 text-[length:var(--fd-text-xs)] text-fg-muted">
          No threads yet
        </p>
      ) : null}
      {visible.map((thread) => (
        <ThreadItem
          key={thread.id}
          thread={thread}
          workspaceId={group.workspace.id}
          isSelected={selectedThreadId === thread.id}
          onSelect={onSelectThread}
          onArchive={onArchiveThread}
          onOpenContextMenu={onOpenThreadContextMenu}
          onRequestRename={onRequestRenameThread}
          nowTick={nowTick}
          tags={threadTagsById?.[thread.id]}
          modelLabel={threadModelLabel(group.workspace, thread)}
        />
      ))}
      {trailingSelected ? (
        <ThreadItem
          key={trailingSelected.id}
          thread={trailingSelected}
          workspaceId={group.workspace.id}
          isSelected
          onSelect={onSelectThread}
          onArchive={onArchiveThread}
          onOpenContextMenu={onOpenThreadContextMenu}
          onRequestRename={onRequestRenameThread}
          nowTick={nowTick}
          tags={threadTagsById?.[trailingSelected.id]}
          modelLabel={threadModelLabel(group.workspace, trailingSelected)}
        />
      ) : null}
      {hiddenCount > 0 || canCollapse ? (
        <div className="flex items-center gap-1">
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setVisibleCount(visibleCount + SHOW_MORE_STEP)}
              className={THREAD_PAGER_BUTTON_CLASS}
            >
              <ChevronDown aria-hidden="true" className="h-3 w-3" />
              Show more
            </button>
          ) : null}
          {canCollapse ? (
            <button
              type="button"
              onClick={() => setVisibleCount(VISIBLE_THREAD_LIMIT)}
              className={cn(
                THREAD_PAGER_BUTTON_CLASS,
                // Pushed right only while it shares the row with "Show more";
                // on its own it keeps the list's left edge.
                hiddenCount > 0 && "ml-auto",
              )}
            >
              Show less
              <ChevronDown aria-hidden="true" className="h-3 w-3 rotate-180" />
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
});

type PinnedThreadEntry = {
  workspaceId: string;
  thread: ThreadSummary;
  /** Resolved where the workspace is still in hand; the row only has the id. */
  modelLabel: string | null;
};

const pinnedEntryKey = (entry: PinnedThreadEntry) =>
  `${entry.workspaceId}:${entry.thread.id}`;
const pinnedEntryThread = (entry: PinnedThreadEntry) => entry.thread;

function WorkspaceDropIndicator() {
  return (
    <div
      aria-hidden="true"
      data-workspace-drop-indicator="true"
      className="mx-1 h-0.5 rounded-full bg-info shadow-[var(--fd-shadow-sm)]"
    />
  );
}

const PinnedThreadList = memo(function PinnedThreadList({
  entries,
  selectedThreadId,
  onSelectThread,
  onArchiveThread,
  onOpenThreadContextMenu,
  onRequestRenameThread,
  nowTick,
  threadTagsById,
}: {
  entries: PinnedThreadEntry[];
  selectedThreadId: string | null;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onArchiveThread?: ThreadItemArchiveHandler;
  onOpenThreadContextMenu?: (args: ThreadContextMenuState) => void;
  onRequestRenameThread?: (args: {
    workspaceId: string;
    thread: ThreadSummary;
  }) => void;
  nowTick: number;
  threadTagsById?: Record<string, ThreadTag[]>;
}) {
  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="fd-pinned-threads-heading" className="mb-4">
      <h2
        id="fd-pinned-threads-heading"
        className="px-2.5 pb-1.5 text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.08em] text-fg-muted"
      >
        Pinned
      </h2>
      <div>
        {entries.map(({ workspaceId, thread, modelLabel }) => (
          <ThreadItem
            key={`${workspaceId}:${thread.id}`}
            thread={thread}
            workspaceId={workspaceId}
            isSelected={selectedThreadId === thread.id}
            onSelect={onSelectThread}
            onArchive={onArchiveThread}
            onOpenContextMenu={onOpenThreadContextMenu}
            onRequestRename={onRequestRenameThread}
            nowTick={nowTick}
            tags={threadTagsById?.[thread.id]}
            modelLabel={modelLabel}
          />
        ))}
      </div>
    </section>
  );
});

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  groups,
  workspaceHosts,
  selectedWorkspaceId,
  selectedThreadId,
  onSelectWorkspace,
  onSelectThread,
  onNewThread,
  onArchiveThread,
  onDeleteThread,
  onRenameThread,
  onTogglePinThread,
  onMarkThreadRead,
  onMarkThreadUnread,
  onAddProject,
  onSearch,
  newThreadShortcut,
  addProjectShortcut,
  searchShortcut,
  onRemoveWorkspace,
  threadSort = "last_updated",
  onThreadSortChange,
  onWorkspaceOrderChange,
  collapsedWorkspaceIds,
  onWorkspaceCollapsedChange,
  isAddingProject = false,
  title = "Threads",
  errors = [],
  emptyState = {
    title: "No projects",
    description: "Add a project folder to get started.",
  },
  footer,
  topNavigation,
  className,
  headerClassName,
  contentClassName,
  threadTagsById,
  threadTagOptions = [],
  onSetThreadStage,
  canSetThreadStage,
  onCreateThreadStage,
  extensionSidebarFilters = [],
  extensionSnapshot,
}: WorkspaceSidebarProps) {
  const [optimisticSelection, setOptimisticSelection] = useState<{
    workspaceId: string | null;
    threadId: string | null;
  } | null>(null);
  const [nowTick, setNowTick] = useState(() =>
    Math.floor(Date.now() / RELATIVE_TIME_TICK_MS),
  );
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [
    uncontrolledCollapsedWorkspaceIds,
    setUncontrolledCollapsedWorkspaceIds,
  ] = useState<Set<string>>(() => new Set());
  const [selectedExtensionFilterValues, setSelectedExtensionFilterValues] =
    useState<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map());
  const [threadContextMenu, setThreadContextMenu] =
    useState<ThreadContextMenuState | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    workspaceId: string;
    thread: ThreadSummary;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenamingThread, setIsRenamingThread] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    workspaceId: string;
    thread: ThreadSummary;
  } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeletingThread, setIsDeletingThread] = useState(false);
  const [workspaceContextMenu, setWorkspaceContextMenu] =
    useState<WorkspaceContextMenuState | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{
    workspaceId: string;
    path: string;
  } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [isRemovingWorkspace, setIsRemovingWorkspace] = useState(false);
  const [createStageTarget, setCreateStageTarget] = useState<{
    workspaceId: string;
    thread: ThreadSummary;
  } | null>(null);
  const [createStageValue, setCreateStageValue] = useState("");
  const [createStageError, setCreateStageError] = useState<string | null>(null);
  const [isCreatingStage, setIsCreatingStage] = useState(false);
  const threadContextMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(
    null,
  );
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [workspaceDragPosition, setWorkspaceDragPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [optimisticWorkspaceOrder, setOptimisticWorkspaceOrder] = useState<
    string[] | null
  >(null);
  const workspaceDragRef = useRef<{
    pointerId: number;
    workspaceId: string;
    startX: number;
    startY: number;
    active: boolean;
    dropIndex: number | null;
  } | null>(null);
  const workspaceRowRefs = useRef(new Map<string, HTMLDivElement>());
  const suppressNextWorkspaceClickRef = useRef(false);
  const pendingSelection =
    optimisticSelection &&
    (optimisticSelection.workspaceId !== selectedWorkspaceId ||
      optimisticSelection.threadId !== selectedThreadId)
      ? optimisticSelection
      : null;

  const visualSelectedWorkspaceId =
    pendingSelection?.workspaceId ?? selectedWorkspaceId;
  const visualSelectedThreadId = pendingSelection?.threadId ?? selectedThreadId;

  const availableTagIds = useMemo(
    () => new Set(threadTagOptions.map((tag) => tag.id)),
    [threadTagOptions],
  );
  const activeTagIds = useMemo(
    () =>
      new Set(
        [...selectedTagIds].filter((tagId) => availableTagIds.has(tagId)),
      ),
    [availableTagIds, selectedTagIds],
  );
  const handleToggleTagFilter = useCallback((tagId: string) => {
    setSelectedTagIds((current) => {
      const next = new Set(current);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }, []);
  const handleClearTagFilters = useCallback(
    () => setSelectedTagIds(new Set()),
    [],
  );
  const dedicatedStageFilter = threadTagOptions.length > 0;
  const genericSidebarFilters = useMemo(
    () =>
      dedicatedStageFilter
        ? extensionSidebarFilters.filter(
            (filter) => filter.extensionId !== THREAD_TAGS_EXTENSION_ID,
          )
        : extensionSidebarFilters,
    [dedicatedStageFilter, extensionSidebarFilters],
  );
  const legacyDisplayGroups = useMemo(() => {
    if (activeTagIds.size === 0) return groups;
    return groups.flatMap((group) => {
      const threads = group.threads.filter((thread) =>
        (threadTagsById?.[thread.id] ?? []).some((tag) =>
          activeTagIds.has(tag.id),
        ),
      );
      return threads.length > 0 ? [{ ...group, threads }] : [];
    });
  }, [activeTagIds, groups, threadTagsById]);
  const activeExtensionFilters = useMemo(
    () =>
      genericSidebarFilters.flatMap((filter): ActiveExtensionThreadFilter[] => {
        const root = filter.document?.root;
        if (!root || root.type !== "select") return [];
        return [
          {
            key: filter.key,
            extensionId: filter.extensionId,
            binding: root.binding,
            selectedValues:
              selectedExtensionFilterValues.get(filter.key) ?? new Set(),
          },
        ];
      }),
    [genericSidebarFilters, selectedExtensionFilterValues],
  );
  const displayGroups = useMemo(
    () =>
      genericSidebarFilters.length > 0
        ? filterProjectGroupsByExtensions(
            legacyDisplayGroups,
            extensionSnapshot,
            activeExtensionFilters,
          )
        : legacyDisplayGroups,
    [
      activeExtensionFilters,
      genericSidebarFilters.length,
      extensionSnapshot,
      legacyDisplayGroups,
    ],
  );
  const handleExtensionFilterChange = useCallback(
    (filterKey: string, values: ReadonlySet<string>) => {
      setSelectedExtensionFilterValues((current) => {
        const next = new Map(current);
        next.set(filterKey, values);
        return next;
      });
    },
    [],
  );

  const orderedGroups = useMemo(() => {
    if (!optimisticWorkspaceOrder) return displayGroups;
    const groupsById = new Map(
      displayGroups.map((group) => [group.workspace.id, group]),
    );
    const orderedIds = [
      ...optimisticWorkspaceOrder,
      ...displayGroups.map((group) => group.workspace.id),
    ];
    const seen = new Set<string>();
    return orderedIds.flatMap((workspaceId) => {
      if (seen.has(workspaceId)) return [];
      seen.add(workspaceId);
      const group = groupsById.get(workspaceId);
      return group ? [group] : [];
    });
  }, [displayGroups, optimisticWorkspaceOrder]);

  const workspaceOrder = useMemo(
    () => orderedGroups.map((group) => group.workspace.id),
    [orderedGroups],
  );

  const collapsedWorkspaces = useMemo(
    () =>
      onWorkspaceCollapsedChange
        ? new Set(collapsedWorkspaceIds ?? [])
        : uncontrolledCollapsedWorkspaceIds,
    [
      collapsedWorkspaceIds,
      onWorkspaceCollapsedChange,
      uncontrolledCollapsedWorkspaceIds,
    ],
  );

  const allProjectsCollapsed =
    workspaceOrder.length > 0 &&
    workspaceOrder.every((workspaceId) => collapsedWorkspaces.has(workspaceId));

  const handleWorkspaceOpenChange = useCallback(
    (workspaceId: string, open: boolean) => {
      if (onWorkspaceCollapsedChange) {
        onWorkspaceCollapsedChange(workspaceId, !open);
        return;
      }
      setUncontrolledCollapsedWorkspaceIds((current) => {
        const next = new Set(current);
        if (open) next.delete(workspaceId);
        else next.add(workspaceId);
        return next;
      });
    },
    [onWorkspaceCollapsedChange],
  );

  const handleToggleAllProjects = useCallback(() => {
    const collapse = !allProjectsCollapsed;
    if (onWorkspaceCollapsedChange) {
      workspaceOrder.forEach((workspaceId) => {
        onWorkspaceCollapsedChange(workspaceId, collapse);
      });
      return;
    }
    setUncontrolledCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      workspaceOrder.forEach((workspaceId) => {
        if (collapse) next.add(workspaceId);
        else next.delete(workspaceId);
      });
      return next;
    });
  }, [allProjectsCollapsed, onWorkspaceCollapsedChange, workspaceOrder]);

  const updateWorkspaceDropIndex = useCallback(
    (clientY: number, workspaceId: string) => {
      const remainingWorkspaceIds = workspaceOrder.filter(
        (id) => id !== workspaceId,
      );
      let nextIndex = remainingWorkspaceIds.length;
      for (let index = 0; index < remainingWorkspaceIds.length; index += 1) {
        const row = workspaceRowRefs.current.get(remainingWorkspaceIds[index]);
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          nextIndex = index;
          break;
        }
      }
      workspaceDragRef.current = workspaceDragRef.current
        ? { ...workspaceDragRef.current, dropIndex: nextIndex }
        : workspaceDragRef.current;
      setDropIndex(nextIndex);
    },
    [workspaceOrder],
  );

  const handleWorkspacePointerDown = useCallback(
    (workspaceId: string, event: React.PointerEvent<HTMLDivElement>) => {
      if (
        !onWorkspaceOrderChange ||
        event.button !== 0 ||
        event.isPrimary === false
      )
        return;
      const target = event.target as HTMLElement;
      if (
        target.closest("a, input, textarea, select, [data-no-workspace-drag]")
      )
        return;
      // Capture is deferred until the drag threshold is crossed: capturing on
      // pointerdown retargets the follow-up click to this row, so the
      // collapse trigger nested inside it would never see the click.
      workspaceDragRef.current = {
        pointerId: event.pointerId,
        workspaceId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        dropIndex: null,
      };
    },
    [onWorkspaceOrderChange],
  );

  const handleWorkspacePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = workspaceDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (!drag.active && distance < WORKSPACE_DRAG_THRESHOLD_PX) return;
      if (!drag.active) {
        drag.active = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDraggingWorkspaceId(drag.workspaceId);
      }
      setWorkspaceDragPosition({ x: event.clientX, y: event.clientY });
      event.preventDefault();
      updateWorkspaceDropIndex(event.clientY, drag.workspaceId);
    },
    [updateWorkspaceDropIndex],
  );

  const finishWorkspaceDrag = useCallback(
    (event?: React.PointerEvent<HTMLDivElement>) => {
      const drag = workspaceDragRef.current;
      if (!drag) return;
      if (
        event &&
        event.pointerId === drag.pointerId &&
        event.currentTarget.hasPointerCapture(event.pointerId)
      ) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      workspaceDragRef.current = null;
      setDraggingWorkspaceId(null);
      setDropIndex(null);
      setWorkspaceDragPosition(null);
      if (!drag.active || drag.dropIndex == null || !onWorkspaceOrderChange)
        return;

      suppressNextWorkspaceClickRef.current = true;
      window.setTimeout(() => {
        suppressNextWorkspaceClickRef.current = false;
      }, 0);

      const remainingWorkspaceIds = workspaceOrder.filter(
        (id) => id !== drag.workspaceId,
      );
      const nextOrder = [...remainingWorkspaceIds];
      nextOrder.splice(
        Math.min(drag.dropIndex, nextOrder.length),
        0,
        drag.workspaceId,
      );
      if (nextOrder.join("\0") === workspaceOrder.join("\0")) return;

      setOptimisticWorkspaceOrder(nextOrder);
      void Promise.resolve(onWorkspaceOrderChange(nextOrder)).catch(() => {
        setOptimisticWorkspaceOrder(null);
      });
    },
    [onWorkspaceOrderChange, workspaceOrder],
  );

  const handleWorkspaceClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!suppressNextWorkspaceClickRef.current) return;
      suppressNextWorkspaceClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  useEffect(() => {
    if (!optimisticWorkspaceOrder) return;
    const currentOrder = groups.map((group) => group.workspace.id);
    if (
      currentOrder.length === optimisticWorkspaceOrder.length &&
      currentOrder.every(
        (workspaceId, index) => workspaceId === optimisticWorkspaceOrder[index],
      )
    ) {
      setOptimisticWorkspaceOrder(null);
    }
  }, [groups, optimisticWorkspaceOrder]);

  const groupMetadata = useMemo(
    () =>
      new Map(
        groups.map((group) => [
          group.workspace.id,
          {
            initialThreadId:
              group.workspace.current_thread_id ?? group.threads[0]?.id ?? null,
            threadIds: new Set(group.threads.map((thread) => thread.id)),
          },
        ]),
      ),
    [groups],
  );

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowTick(Math.floor(Date.now() / RELATIVE_TIME_TICK_MS));
    }, RELATIVE_TIME_TICK_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    setOptimisticSelection((current) => {
      if (!current) return null;
      if (
        current.workspaceId === selectedWorkspaceId &&
        current.threadId === selectedThreadId
      ) {
        return null;
      }

      const metadata = current.workspaceId
        ? groupMetadata.get(current.workspaceId)
        : null;
      if (!metadata) {
        return null;
      }
      if (current.threadId === null) {
        return current;
      }
      return metadata.threadIds.has(current.threadId) ? current : null;
    });
  }, [groupMetadata, selectedThreadId, selectedWorkspaceId]);

  useEffect(() => {
    if (!pendingSelection) return;

    const timeout = window.setTimeout(() => {
      setOptimisticSelection((current) =>
        current === pendingSelection ? null : current,
      );
    }, OPTIMISTIC_SELECTION_TTL_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [pendingSelection]);

  const handleSelectWorkspace = useCallback(
    (workspaceId: string, threadId: string | null) => {
      setOptimisticSelection({ workspaceId, threadId });
      onSelectWorkspace(workspaceId, threadId);
    },
    [onSelectWorkspace],
  );

  const handleSelectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      setOptimisticSelection({ workspaceId, threadId });
      onSelectThread(workspaceId, threadId);
    },
    [onSelectThread],
  );

  const handleNewThread = useCallback(
    (workspaceId: string) => {
      if (!onNewThread) return;
      setOptimisticSelection({ workspaceId, threadId: null });
      onNewThread(workspaceId);
    },
    [onNewThread],
  );

  const closeThreadContextMenu = useCallback(() => {
    setThreadContextMenu(null);
  }, []);

  const resetRenameDialog = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
    setRenameError(null);
  }, []);

  const closeRenameDialog = useCallback(() => {
    if (isRenamingThread) return;
    resetRenameDialog();
  }, [isRenamingThread, resetRenameDialog]);

  const openRenameDialog = useCallback(
    (workspaceId: string, thread: ThreadSummary) => {
      setThreadContextMenu(null);
      setRenameTarget({ workspaceId, thread });
      setRenameValue(thread.title);
      setRenameError(null);
    },
    [],
  );

  const handleOpenThreadContextMenu = useCallback(
    (args: ThreadContextMenuState) => {
      if (
        !onArchiveThread &&
        !onDeleteThread &&
        !onRenameThread &&
        !onTogglePinThread &&
        !onMarkThreadRead &&
        !onMarkThreadUnread &&
        !onSetThreadStage
      ) {
        return;
      }
      setThreadContextMenu(args);
    },
    [
      onArchiveThread,
      onDeleteThread,
      onMarkThreadRead,
      onMarkThreadUnread,
      onRenameThread,
      onSetThreadStage,
      onTogglePinThread,
    ],
  );

  const openDeleteDialog = useCallback(() => {
    if (!threadContextMenu || !onDeleteThread) return;
    const { workspaceId, thread } = threadContextMenu;
    setThreadContextMenu(null);
    setDeleteError(null);
    setDeleteTarget({ workspaceId, thread });
  }, [onDeleteThread, threadContextMenu]);

  const closeDeleteDialog = useCallback(() => {
    if (isDeletingThread) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }, [isDeletingThread]);

  const handleConfirmDeleteThread = useCallback(async () => {
    if (!deleteTarget || !onDeleteThread) return;

    setIsDeletingThread(true);
    setDeleteError(null);
    try {
      await onDeleteThread(deleteTarget.workspaceId, deleteTarget.thread.id);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Failed to delete thread",
      );
    } finally {
      setIsDeletingThread(false);
    }
  }, [deleteTarget, onDeleteThread]);

  const handleArchiveFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onArchiveThread) return;
    const { workspaceId, thread } = threadContextMenu;
    setThreadContextMenu(null);
    void Promise.resolve(onArchiveThread(workspaceId, thread.id)).catch(
      () => {},
    );
  }, [onArchiveThread, threadContextMenu]);

  const handleStartRenameFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onRenameThread) return;
    openRenameDialog(threadContextMenu.workspaceId, threadContextMenu.thread);
  }, [onRenameThread, openRenameDialog, threadContextMenu]);

  const handleRequestRenameThreadFromRow = useCallback(
    ({
      workspaceId,
      thread,
    }: {
      workspaceId: string;
      thread: ThreadSummary;
    }) => {
      openRenameDialog(workspaceId, thread);
    },
    [openRenameDialog],
  );
  const handleRequestRenameThread = onRenameThread
    ? handleRequestRenameThreadFromRow
    : undefined;

  const handleTogglePinFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onTogglePinThread) return;
    const { workspaceId, thread } = threadContextMenu;
    setThreadContextMenu(null);
    void Promise.resolve(
      onTogglePinThread(workspaceId, thread.id, !thread.is_pinned),
    ).catch(() => {});
  }, [onTogglePinThread, threadContextMenu]);

  const handleMarkReadFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onMarkThreadRead) return;
    const { workspaceId, thread } = threadContextMenu;
    setThreadContextMenu(null);
    void Promise.resolve(onMarkThreadRead(workspaceId, thread.id)).catch(
      () => {},
    );
  }, [onMarkThreadRead, threadContextMenu]);

  const handleMarkUnreadFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onMarkThreadUnread) return;
    const { workspaceId, thread } = threadContextMenu;
    setThreadContextMenu(null);
    void Promise.resolve(onMarkThreadUnread(workspaceId, thread.id)).catch(
      () => {},
    );
  }, [onMarkThreadUnread, threadContextMenu]);

  const handleSetStageFromContextMenu = useCallback(
    (stage: ThreadTag | null) => {
      if (
        !threadContextMenu ||
        !onSetThreadStage ||
        (canSetThreadStage && !canSetThreadStage(threadContextMenu.workspaceId))
      )
        return;
      const { workspaceId, thread } = threadContextMenu;
      setThreadContextMenu(null);
      void Promise.resolve(onSetThreadStage(workspaceId, thread, stage)).catch(
        () => {},
      );
    },
    [canSetThreadStage, onSetThreadStage, threadContextMenu],
  );

  const openCreateStageDialog = useCallback(() => {
    if (!threadContextMenu || !onCreateThreadStage) return;
    const { workspaceId, thread } = threadContextMenu;
    setThreadContextMenu(null);
    setCreateStageTarget({ workspaceId, thread });
    setCreateStageValue("");
    setCreateStageError(null);
  }, [onCreateThreadStage, threadContextMenu]);

  const closeCreateStageDialog = useCallback(() => {
    if (isCreatingStage) return;
    setCreateStageTarget(null);
    setCreateStageValue("");
    setCreateStageError(null);
  }, [isCreatingStage]);

  const handleConfirmCreateStage = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!createStageTarget || !onCreateThreadStage) return;
      const label = createStageValue.trim();
      if (!label) {
        setCreateStageError("Stage name cannot be empty");
        return;
      }
      setIsCreatingStage(true);
      setCreateStageError(null);
      try {
        await onCreateThreadStage(
          createStageTarget.workspaceId,
          createStageTarget.thread,
          label,
        );
        setCreateStageTarget(null);
        setCreateStageValue("");
      } catch (error) {
        setCreateStageError(
          error instanceof Error ? error.message : "Failed to add stage",
        );
      } finally {
        setIsCreatingStage(false);
      }
    },
    [createStageTarget, createStageValue, onCreateThreadStage],
  );

  const handleOpenWorkspaceContextMenu = useCallback(
    (workspaceId: string, path: string, position: { x: number; y: number }) => {
      if (!onRemoveWorkspace) return;
      setThreadContextMenu(null);
      setWorkspaceContextMenu({
        workspaceId,
        path,
        x: position.x,
        y: position.y,
      });
    },
    [onRemoveWorkspace],
  );

  const openRemoveDialog = useCallback(() => {
    if (!workspaceContextMenu) return;
    const { workspaceId, path } = workspaceContextMenu;
    setWorkspaceContextMenu(null);
    setRemoveError(null);
    setRemoveTarget({ workspaceId, path });
  }, [workspaceContextMenu]);

  const closeRemoveDialog = useCallback(() => {
    if (isRemovingWorkspace) return;
    setRemoveTarget(null);
    setRemoveError(null);
  }, [isRemovingWorkspace]);

  const handleConfirmRemoveWorkspace = useCallback(async () => {
    if (!removeTarget || !onRemoveWorkspace) return;

    setIsRemovingWorkspace(true);
    setRemoveError(null);
    try {
      await onRemoveWorkspace(removeTarget.workspaceId);
      setRemoveTarget(null);
    } catch (error) {
      setRemoveError(
        error instanceof Error ? error.message : "Failed to remove project",
      );
    } finally {
      setIsRemovingWorkspace(false);
    }
  }, [onRemoveWorkspace, removeTarget]);

  const workspacePathById = useMemo(
    () =>
      new Map(
        groups.map((group) => [group.workspace.id, group.workspace.path]),
      ),
    [groups],
  );
  // Pinned chats come from every project, so they get a single global sort
  // rather than the per-project ordering below.
  const pinnedCandidates = useMemo(
    () =>
      displayGroups.flatMap((group) =>
        group.threads
          .filter((thread) => thread.is_pinned)
          .map((thread) => ({
            workspaceId: group.workspace.id,
            thread,
            modelLabel: threadModelLabel(group.workspace, thread),
          })),
      ),
    [displayGroups],
  );
  const stablePinnedThreads = useStablePriorityOrder(
    pinnedCandidates,
    visualSelectedThreadId,
    threadSort === "priority",
    pinnedEntryKey,
    pinnedEntryThread,
  );
  const pinnedThreads = useMemo(() => {
    if (threadSort === "priority") return stablePinnedThreads;
    const compare = compareThreads(threadSort);
    return [...pinnedCandidates].sort((left, right) =>
      compare(left.thread, right.thread),
    );
  }, [pinnedCandidates, stablePinnedThreads, threadSort]);

  // Starting a thread should never depend on first picking a project: the
  // selected one is the obvious target, and the top of the list stands in
  // before anything is selected.
  const newThreadWorkspaceId =
    (visualSelectedWorkspaceId &&
    orderedGroups.some(
      (group) => group.workspace.id === visualSelectedWorkspaceId,
    )
      ? visualSelectedWorkspaceId
      : null) ??
    orderedGroups[0]?.workspace.id ??
    null;

  const newThreadRow =
    onNewThread && newThreadWorkspaceId ? (
      <button
        type="button"
        onClick={() => handleNewThread(newThreadWorkspaceId)}
        title={
          newThreadShortcut ? `New thread (${newThreadShortcut})` : "New thread"
        }
        className="fd-focus group mb-1 flex w-full items-center gap-1.5 rounded-[var(--fd-radius-md)] py-1.5 pl-1.5 pr-3 text-left text-[length:var(--fd-text-sm)] font-medium text-fg-primary transition-colors hover:bg-surface-3"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-secondary transition-colors group-hover:bg-surface-4 group-hover:text-fg-primary">
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">New thread</span>
        {newThreadShortcut ? (
          <span
            aria-hidden="true"
            className="fd-readout shrink-0 text-[length:var(--fd-text-xs)] text-fg-muted"
          >
            {newThreadShortcut}
          </span>
        ) : null}
      </button>
    ) : null;

  const handleRenameSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!renameTarget || !onRenameThread) return;

      const nextTitle = renameValue.trim();
      if (!nextTitle) {
        setRenameError("Title cannot be empty");
        return;
      }

      setIsRenamingThread(true);
      setRenameError(null);
      try {
        await onRenameThread(
          renameTarget.workspaceId,
          renameTarget.thread.id,
          nextTitle,
        );
        resetRenameDialog();
      } catch (error) {
        setRenameError(
          error instanceof Error ? error.message : "Failed to rename thread",
        );
      } finally {
        setIsRenamingThread(false);
      }
    },
    [onRenameThread, renameTarget, renameValue, resetRenameDialog],
  );

  useEffect(() => {
    if (!threadContextMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (threadContextMenuRef.current?.contains(event.target as Node)) return;
      setThreadContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setThreadContextMenu(null);
    };

    const handleViewportChange = (event: Event) => {
      if (
        event.target instanceof Node &&
        threadContextMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      setThreadContextMenu(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [threadContextMenu]);

  useEffect(() => {
    if (!workspaceContextMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (workspaceContextMenuRef.current?.contains(event.target as Node))
        return;
      setWorkspaceContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setWorkspaceContextMenu(null);
    };

    const handleViewportChange = () => {
      setWorkspaceContextMenu(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [workspaceContextMenu]);

  useEffect(() => {
    if (!renameTarget) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isRenamingThread) return;
      resetRenameDialog();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isRenamingThread, renameTarget, resetRenameDialog]);

  useEffect(() => {
    if (!deleteTarget) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isDeletingThread) return;
      setDeleteTarget(null);
      setDeleteError(null);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [deleteTarget, isDeletingThread]);

  useEffect(() => {
    if (!removeTarget) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isRemovingWorkspace) return;
      setRemoveTarget(null);
      setRemoveError(null);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isRemovingWorkspace, removeTarget]);

  useEffect(() => {
    if (!createStageTarget) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isCreatingStage) return;
      closeCreateStageDialog();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeCreateStageDialog, createStageTarget, isCreatingStage]);

  return (
    <SidebarShell className={className}>
      <SidebarHeader
        className={headerClassName}
        // Restores window dragging over the traffic-light row on desktop.
        data-tauri-drag-region="deep"
      >
        <div className="flex items-center justify-between">
          {/* Starting a thread is the sidebar's primary action, so it gets a
              row of its own at the top of the list rather than a quiet header
              link competing with the window controls. */}
          <span className="text-[length:var(--fd-text-sm)] text-fg-muted">
            {title}
          </span>
          {onSearch ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onSearch}
              title={searchShortcut ? `Search (${searchShortcut})` : "Search"}
              aria-label="Search"
            >
              <Search aria-hidden="true" className="h-4 w-4" />
            </Button>
          ) : null}
        </div>

        {errors.filter(Boolean).map((error) => (
          <p
            key={error}
            className="text-[length:var(--fd-text-xs)] text-warning"
          >
            {error}
          </p>
        ))}
      </SidebarHeader>

      <SidebarContent className={contentClassName}>
        {newThreadRow || topNavigation ? (
          <nav className="mb-4">
            {newThreadRow}
            {topNavigation}
          </nav>
        ) : null}
        <PinnedThreadList
          entries={pinnedThreads}
          selectedThreadId={visualSelectedThreadId}
          onSelectThread={handleSelectThread}
          onArchiveThread={onArchiveThread}
          onOpenThreadContextMenu={handleOpenThreadContextMenu}
          onRequestRenameThread={handleRequestRenameThread}
          nowTick={nowTick}
          threadTagsById={threadTagsById}
        />
        <AttentionInbox
          groups={displayGroups}
          selectedThreadId={visualSelectedThreadId}
          onSelectThread={handleSelectThread}
        />
        <section aria-labelledby="fd-projects-heading">
          {/* The action icons are optically aligned with the per-project new
              thread button below: that glyph sits 10px from the sidebar edge
              (px-2 row + p-0.5 button), while these 24px icon buttons inset
              their 14px glyph by 5px — so the trailing padding drops to match. */}
          <div className="flex items-center justify-between pb-1.5 pl-2.5 pr-[5px]">
            <h2 id="fd-projects-heading">
              <button
                type="button"
                className="group/projects fd-focus relative rounded-[var(--fd-radius-sm)] pr-4 text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.08em] text-fg-muted transition-colors hover:text-fg-secondary disabled:cursor-default disabled:opacity-60"
                onClick={handleToggleAllProjects}
                disabled={workspaceOrder.length === 0}
                aria-expanded={!allProjectsCollapsed}
                aria-label={
                  allProjectsCollapsed
                    ? "Expand all projects"
                    : "Collapse all projects"
                }
                title={
                  allProjectsCollapsed
                    ? "Expand all projects"
                    : "Collapse all projects"
                }
              >
                Projects
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 opacity-0 transition-[transform,opacity] duration-[var(--fd-duration-fast)] group-hover/projects:opacity-100 group-focus-visible/projects:opacity-100",
                    allProjectsCollapsed && "-rotate-90",
                  )}
                />
              </button>
            </h2>
            <div className="flex items-center gap-1">
              {dedicatedStageFilter ? (
                <ThreadStageFilterMenu
                  options={threadTagOptions}
                  selectedIds={activeTagIds}
                  onToggle={handleToggleTagFilter}
                  onClear={handleClearTagFilters}
                />
              ) : null}
              {genericSidebarFilters.length > 0 ? (
                <ExtensionSidebarFilters
                  definitions={genericSidebarFilters}
                  selections={selectedExtensionFilterValues}
                  onChange={handleExtensionFilterChange}
                />
              ) : null}
              {onThreadSortChange ? (
                <ThreadSortMenu
                  value={threadSort}
                  onChange={onThreadSortChange}
                />
              ) : null}
              {/* Adding a project belongs beside the projects it adds to. */}
              {onAddProject ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={onAddProject}
                  disabled={isAddingProject}
                  title={
                    addProjectShortcut
                      ? `Add project (${addProjectShortcut})`
                      : "Add project"
                  }
                  aria-label="Add project"
                  aria-busy={isAddingProject}
                >
                  {isAddingProject ? (
                    <ActivityDiamond size="md" />
                  ) : (
                    <FolderPlus aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="space-y-4">
            {(() => {
              let remainingIndex = 0;
              const remainingWorkspaceIds = orderedGroups
                .map((group) => group.workspace.id)
                .filter((workspaceId) => workspaceId !== draggingWorkspaceId);
              const lastRemainingWorkspaceId = remainingWorkspaceIds.at(-1);
              return orderedGroups.map((group) => {
                const workspaceId = group.workspace.id;
                const isDragged = draggingWorkspaceId === workspaceId;
                const showDropBefore =
                  draggingWorkspaceId != null &&
                  !isDragged &&
                  dropIndex === remainingIndex;
                if (!isDragged) remainingIndex += 1;
                const dragHandleProps = onWorkspaceOrderChange
                  ? {
                      ref: (node: HTMLDivElement | null) => {
                        if (node)
                          workspaceRowRefs.current.set(workspaceId, node);
                        else workspaceRowRefs.current.delete(workspaceId);
                      },
                      onPointerDown: (
                        event: React.PointerEvent<HTMLDivElement>,
                      ) => handleWorkspacePointerDown(workspaceId, event),
                      onPointerMove: handleWorkspacePointerMove,
                      onPointerUp: finishWorkspaceDrag,
                      onPointerCancel: finishWorkspaceDrag,
                      onClickCapture: handleWorkspaceClickCapture,
                      "data-workspace-drag-id": workspaceId,
                      "aria-grabbed": isDragged ? true : undefined,
                      className: cn(
                        "cursor-grab select-none",
                        isDragged && "cursor-grabbing opacity-50",
                      ),
                      style: { touchAction: "none" },
                    }
                  : undefined;

                return (
                  <React.Fragment key={workspaceId}>
                    {showDropBefore ? <WorkspaceDropIndicator /> : null}
                    <WorkspaceGroup
                      workspace={group.workspace}
                      host={workspaceHosts?.[workspaceId] ?? null}
                      isSelected={visualSelectedWorkspaceId === workspaceId}
                      onSelect={() =>
                        handleSelectWorkspace(
                          workspaceId,
                          groupMetadata.get(workspaceId)?.initialThreadId ??
                            null,
                        )
                      }
                      onNewThread={
                        onNewThread
                          ? () => handleNewThread(workspaceId)
                          : undefined
                      }
                      onOpenContextMenu={
                        onRemoveWorkspace
                          ? (position) =>
                              handleOpenWorkspaceContextMenu(
                                workspaceId,
                                group.workspace.path,
                                position,
                              )
                          : undefined
                      }
                      dragHandleProps={dragHandleProps}
                      open={!collapsedWorkspaces.has(workspaceId)}
                      onOpenChange={(open) =>
                        handleWorkspaceOpenChange(workspaceId, open)
                      }
                    >
                      <ThreadList
                        group={group}
                        sortMode={threadSort}
                        selectedThreadId={visualSelectedThreadId}
                        onSelectThread={handleSelectThread}
                        onArchiveThread={onArchiveThread}
                        onOpenThreadContextMenu={handleOpenThreadContextMenu}
                        onRequestRenameThread={handleRequestRenameThread}
                        nowTick={nowTick}
                        threadTagsById={threadTagsById}
                      />
                    </WorkspaceGroup>
                    {draggingWorkspaceId != null &&
                    workspaceId === lastRemainingWorkspaceId &&
                    dropIndex === remainingWorkspaceIds.length ? (
                      <WorkspaceDropIndicator />
                    ) : null}
                  </React.Fragment>
                );
              });
            })()}
            {groups.length === 0 ? (
              <EmptyState
                icon={
                  onAddProject ? <FolderPlus className="h-5 w-5" /> : undefined
                }
                title={emptyState.title}
                description={emptyState.description}
              />
            ) : null}
          </div>
        </section>
      </SidebarContent>
      {footer ? (
        <div className="border-t border-border-subtle p-3">{footer}</div>
      ) : null}
      <ThreadContextMenu
        menuRef={threadContextMenuRef}
        target={threadContextMenu}
        workspacePath={
          threadContextMenu
            ? (workspacePathById.get(threadContextMenu.workspaceId) ?? null)
            : null
        }
        canRename={Boolean(onRenameThread)}
        canArchive={Boolean(onArchiveThread)}
        canDelete={Boolean(onDeleteThread)}
        canPin={Boolean(onTogglePinThread)}
        canMarkRead={Boolean(onMarkThreadRead)}
        canMarkUnread={Boolean(onMarkThreadUnread)}
        stageOptions={
          onSetThreadStage &&
          threadContextMenu &&
          (!canSetThreadStage ||
            canSetThreadStage(threadContextMenu.workspaceId))
            ? threadTagOptions
            : []
        }
        selectedStage={
          threadContextMenu
            ? (threadTagsById?.[threadContextMenu.thread.id]?.[0] ?? null)
            : null
        }
        onClose={closeThreadContextMenu}
        onRename={handleStartRenameFromContextMenu}
        onArchive={handleArchiveFromContextMenu}
        onDelete={openDeleteDialog}
        onTogglePin={handleTogglePinFromContextMenu}
        onMarkRead={handleMarkReadFromContextMenu}
        onMarkUnread={handleMarkUnreadFromContextMenu}
        onSetStage={handleSetStageFromContextMenu}
        onCreateStage={onCreateThreadStage ? openCreateStageDialog : undefined}
      />
      <AddThreadStageDialog
        target={createStageTarget}
        value={createStageValue}
        error={createStageError}
        pending={isCreatingStage}
        onChange={setCreateStageValue}
        onClose={closeCreateStageDialog}
        onSubmit={handleConfirmCreateStage}
      />
      <DeleteThreadDialog
        target={deleteTarget}
        error={deleteError}
        pending={isDeletingThread}
        onClose={closeDeleteDialog}
        onConfirm={handleConfirmDeleteThread}
      />
      <RenameThreadDialog
        target={renameTarget}
        value={renameValue}
        error={renameError}
        pending={isRenamingThread}
        onChange={setRenameValue}
        onClose={closeRenameDialog}
        onSubmit={handleRenameSubmit}
      />
      <WorkspaceContextMenu
        menuRef={workspaceContextMenuRef}
        target={workspaceContextMenu}
        onRemove={openRemoveDialog}
      />
      <RemoveWorkspaceDialog
        target={removeTarget}
        error={removeError}
        pending={isRemovingWorkspace}
        onClose={closeRemoveDialog}
        onConfirm={handleConfirmRemoveWorkspace}
      />
      {draggingWorkspaceId && workspaceDragPosition
        ? createPortal(
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-[100] flex max-w-64 items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-2.5 py-1.5 text-[length:var(--fd-text-sm)] font-medium text-fg-primary shadow-[var(--fd-shadow-lg)]"
              style={{
                left: workspaceDragPosition.x + 12,
                top: workspaceDragPosition.y + 12,
              }}
            >
              <FolderClosed className="h-4 w-4 shrink-0 text-fg-muted" />
              <span className="truncate">
                {orderedGroups
                  .find((group) => group.workspace.id === draggingWorkspaceId)
                  ?.workspace.path.split("/")
                  .pop() ?? "Project"}
              </span>
            </div>,
            document.body,
          )
        : null}
    </SidebarShell>
  );
});
