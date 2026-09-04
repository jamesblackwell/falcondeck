import * as React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  ChevronDown,
  FolderClosed,
  FolderPlus,
  Plus,
  Search,
  X,
} from "lucide-react";

import {
  compareThreads,
  filterProjectGroupsByExtensions,
  partitionSidebarThreads,
  summarizeThreadAttention,
  THREAD_TAGS_EXTENSION_ID,
  threadProviderLabel,
  threadPriorityRank,
} from "@falcondeck/client-core";
import type {
  ActiveExtensionThreadFilter,
  ExtensionSidebarFilterDefinition,
  ExtensionSnapshot,
  LibraryWorkspace,
  ProjectGroup,
  ThreadSortMode,
  ThreadSummary,
  ThreadTag,
  WorkspaceColorId,
} from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Button,
  EmptyState,
  Sidebar as SidebarShell,
  SidebarContent,
  SidebarHeader,
  Tooltip,
  cn,
} from "@falcondeck/ui";

import { AddProjectMenu } from "./add-project-menu";
import { AttentionInbox } from "./attention-inbox";
import { ExtensionSidebarFilters } from "./extension-sidebar-filters";
import { ThreadStageFilterMenu } from "./thread-stage-filter-menu";
import { ThreadSortMenu } from "./thread-sort-menu";
import {
  AddThreadStageDialog,
  CloseWorkspaceDialog,
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
// Same chrome as the Projects sort/filter triggers and per-project SquarePen.
const SIDEBAR_SECTION_ICON_BUTTON_CLASS =
  "fd-focus -my-0.5 shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary disabled:pointer-events-none disabled:opacity-40";
const SIDEBAR_SECTION_HEADING_BUTTON_CLASS =
  "fd-focus relative rounded-[var(--fd-radius-sm)] pr-4 text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.08em] text-fg-muted transition-colors hover:text-fg-secondary disabled:cursor-default disabled:opacity-60";
const SIDEBAR_SECTION_HEADING_LABEL_CLASS =
  "text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.08em] text-fg-muted";
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
  /** Creates a conversation outside a user project. */
  onNewChat?: () => Promise<void> | void;
  /** Open the command palette scoped to one project's threads. */
  onSearchProjectThreads?: (workspaceId: string) => void;
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
  /** Fills the rename field from recent conversation; does not save. */
  onSuggestThreadTitle?: (
    workspaceId: string,
    threadId: string,
  ) => Promise<string>;
  /** Continues a thread in a fresh, independent copy; the source is unchanged. */
  onForkThread?: (
    workspaceId: string,
    threadId: string,
  ) => Promise<void> | void;
  onTogglePinThread?: (
    workspaceId: string,
    threadId: string,
    pinned: boolean,
  ) => Promise<void> | void;
  onTogglePinThreadInProject?: (
    workspaceId: string,
    threadId: string,
    pinnedInProject: boolean,
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
  /** Binding tokens ("⌘", "N") for header tooltips, when the host binds them. */
  newThreadShortcut?: string[];
  addProjectShortcut?: string[];
  searchShortcut?: string[];
  onRemoveWorkspace?: (workspaceId: string) => Promise<void> | void;
  /** Closes a project from the sidebar without forgetting it. */
  onCloseWorkspace?: (workspaceId: string) => Promise<void> | void;
  /** When set, closing this project needs a confirm dialog with this copy. */
  closeWorkspaceReason?: (workspaceId: string) => string | null;
  /** Closed projects that can be reopened without a folder picker. */
  libraryWorkspaces?: readonly LibraryWorkspace[];
  onOpenLibraryWorkspace?: (path: string) => Promise<void> | void;
  /** Theme-backed folder colors keyed by workspace id. */
  workspaceColors?: Record<string, string>;
  onWorkspaceColorChange?: (
    workspaceId: string,
    color: WorkspaceColorId | null,
  ) => Promise<void> | void;
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
  /** When true, the Projects list is folded away. Host-owned like chats collapse. */
  projectsCollapsed?: boolean;
  onProjectsCollapsedChange?: (collapsed: boolean) => void;
  /** When true, the Chats list is folded away. Host-owned like project collapse. */
  chatsCollapsed?: boolean;
  onChatsCollapsedChange?: (collapsed: boolean) => void;
  isAddingProject?: boolean;
  /** Optional chrome label. Desktop and the hosted app omit it so the
   *  titlebar is just window controls and search. */
  title?: string;
  errors?: string[];
  /** Dismiss handler for an error banner. Omit to render the banners
   *  without a close affordance. */
  onDismissError?: (error: string) => void;
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

type StableRecencyState = {
  key: string;
  wasRunning: boolean;
};

const summaryKey = (thread: ThreadSummary) => thread.id;
const summaryThread = (thread: ThreadSummary) => thread;

/**
 * Keeps Priority useful as a work queue instead of a live activity sort.
 * Promotions apply immediately, but demotions wait until Priority mode is
 * re-entered. Selecting a row commonly marks it read, so letting selection
 * release deferred demotions would make the list jump under the pointer.
 */
function useStablePriorityOrder<Item>(
  items: Item[],
  active: boolean,
  keyFor: (item: Item) => string,
  threadFor: (item: Item) => ThreadSummary,
) {
  const queueRef = useRef(new Map<string, PriorityQueueState>());
  const wasActiveRef = useRef(false);
  const nextFrontOrderRef = useRef(-1);

  return useMemo(() => {
    if (!active) {
      wasActiveRef.current = false;
      return items;
    }

    const enteringPriority = !wasActiveRef.current;
    wasActiveRef.current = true;

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
        if (current && desiredBucket < current.bucket) {
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
  }, [active, items, keyFor, threadFor]);
}

/**
 * A running thread's updated_at bumps with every streamed event, which would
 * otherwise make Last updated rows constantly swap places mid-list. Freeze the
 * sort key while a thread stays running — it keeps the recency slot it had
 * when the turn started — and let it settle to its final position once done.
 * Idle threads still rise immediately on real activity.
 */
function useStableRecencyOrder<Item>(
  items: Item[],
  active: boolean,
  keyFor: (item: Item) => string,
  threadFor: (item: Item) => ThreadSummary,
) {
  const keyStateRef = useRef(new Map<string, StableRecencyState>());

  return useMemo(() => {
    if (!active) return items;

    const liveIds = new Set(items.map(keyFor));
    for (const id of keyStateRef.current.keys()) {
      if (!liveIds.has(id)) keyStateRef.current.delete(id);
    }

    for (const item of items) {
      const id = keyFor(item);
      const thread = threadFor(item);
      const running = thread.status === "running";
      const previous = keyStateRef.current.get(id);
      // Only freeze a key that was captured while running; the first running
      // snapshot (turn start) and the settling one (turn end) both count as
      // real movement.
      if (previous && running && previous.wasRunning) continue;
      keyStateRef.current.set(id, {
        key: thread.updated_at,
        wasRunning: running,
      });
    }

    return [...items].sort((left, right) => {
      const leftKey = keyStateRef.current.get(keyFor(left))?.key ?? "";
      const rightKey = keyStateRef.current.get(keyFor(right))?.key ?? "";
      return (
        (rightKey < leftKey ? -1 : rightKey > leftKey ? 1 : 0) ||
        keyFor(left).localeCompare(keyFor(right))
      );
    });
  }, [active, items, keyFor, threadFor]);
}

function useOrderedThreads(threads: ThreadSummary[], sortMode: ThreadSortMode) {
  const stablePriorityThreads = useStablePriorityOrder(
    threads,
    sortMode === "priority",
    summaryKey,
    summaryThread,
  );
  const stableRecencyThreads = useStableRecencyOrder(
    threads,
    sortMode === "last_updated",
    summaryKey,
    summaryThread,
  );
  return useMemo(
    () =>
      sortMode === "priority"
        ? stablePriorityThreads
        : sortMode === "last_updated"
          ? stableRecencyThreads
          : [...threads].sort(compareThreads(sortMode)),
    [sortMode, stablePriorityThreads, stableRecencyThreads, threads],
  );
}

const ThreadList = memo(function ThreadList({
  group,
  sortMode,
  selectedThreadId,
  onSelectThread,
  onArchiveThread,
  onArchiveConfirm,
  onArchiveCancel,
  pendingArchive,
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
  onArchiveConfirm?: () => void;
  onArchiveCancel?: () => void;
  pendingArchive?: { workspaceId: string; threadId: string } | null;
  onOpenThreadContextMenu?: (args: ThreadContextMenuState) => void;
  onRequestRenameThread?: (args: {
    workspaceId: string;
    thread: ThreadSummary;
  }) => void;
  nowTick: number;
  threadTagsById?: Record<string, ThreadTag[]>;
}) {
  const [visibleCount, setVisibleCount] = useState(VISIBLE_THREAD_LIMIT);
  const { pinnedInProject, unpinned } = useMemo(
    () => partitionSidebarThreads(group.threads),
    [group.threads],
  );
  const pinnedInProjectThreads = useOrderedThreads(pinnedInProject, sortMode);
  const unpinnedThreads = useOrderedThreads(unpinned, sortMode);

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
      {[...pinnedInProjectThreads, ...visible].map((thread) => (
        <ThreadItem
          key={thread.id}
          thread={thread}
          workspaceId={group.workspace.id}
          isSelected={selectedThreadId === thread.id}
          onSelect={onSelectThread}
          onArchive={onArchiveThread}
          archiveConfirmPending={Boolean(
            pendingArchive &&
              pendingArchive.workspaceId === group.workspace.id &&
              pendingArchive.threadId === thread.id,
          )}
          onArchiveConfirm={onArchiveConfirm}
          onArchiveCancel={onArchiveCancel}
          onOpenContextMenu={onOpenThreadContextMenu}
          onRequestRename={onRequestRenameThread}
          nowTick={nowTick}
          tags={threadTagsById?.[thread.id]}
          providerLabel={threadProviderLabel(group.workspace, thread)}
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
          archiveConfirmPending={Boolean(
            pendingArchive &&
              pendingArchive.workspaceId === group.workspace.id &&
              pendingArchive.threadId === trailingSelected.id,
          )}
          onArchiveConfirm={onArchiveConfirm}
          onArchiveCancel={onArchiveCancel}
          onOpenContextMenu={onOpenThreadContextMenu}
          onRequestRename={onRequestRenameThread}
          nowTick={nowTick}
          tags={threadTagsById?.[trailingSelected.id]}
          providerLabel={threadProviderLabel(group.workspace, trailingSelected)}
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
  providerLabel: string | null;
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
  onArchiveConfirm,
  onArchiveCancel,
  pendingArchive,
  onOpenThreadContextMenu,
  onRequestRenameThread,
  nowTick,
  threadTagsById,
}: {
  entries: PinnedThreadEntry[];
  selectedThreadId: string | null;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onArchiveThread?: ThreadItemArchiveHandler;
  onArchiveConfirm?: () => void;
  onArchiveCancel?: () => void;
  pendingArchive?: { workspaceId: string; threadId: string } | null;
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
        {entries.map(({ workspaceId, thread, providerLabel }) => (
          <ThreadItem
            key={`${workspaceId}:${thread.id}`}
            thread={thread}
            workspaceId={workspaceId}
            isSelected={selectedThreadId === thread.id}
            onSelect={onSelectThread}
            onArchive={onArchiveThread}
            archiveConfirmPending={Boolean(
              pendingArchive &&
                pendingArchive.workspaceId === workspaceId &&
                pendingArchive.threadId === thread.id,
            )}
            onArchiveConfirm={onArchiveConfirm}
            onArchiveCancel={onArchiveCancel}
            onOpenContextMenu={onOpenThreadContextMenu}
            onRequestRename={onRequestRenameThread}
            nowTick={nowTick}
            tags={threadTagsById?.[thread.id]}
            providerLabel={providerLabel}
          />
        ))}
      </div>
    </section>
  );
});

/**
 * Isolated so toggling the Projects heading does not rebuild every folder
 * row while the section collapse animation is running.
 */
const ProjectGroupList = memo(function ProjectGroupList({
  orderedGroups,
  draggingWorkspaceId,
  dropIndex,
  onWorkspaceOrderChange,
  workspaceRowRefs,
  onWorkspacePointerDown,
  onWorkspacePointerMove,
  onWorkspacePointerUp,
  onWorkspaceClickCapture,
  visualSelectedWorkspaceId,
  onSelectWorkspace,
  onNewThread,
  onSearchProjectThreads,
  canOpenWorkspaceContextMenu,
  onOpenWorkspaceContextMenu,
  workspaceColors,
  workspaceHosts,
  collapsedWorkspaces,
  onWorkspaceOpenChange,
  threadSort,
  visualSelectedThreadId,
  onSelectThread,
  onArchiveThread,
  onArchiveConfirm,
  onArchiveCancel,
  pendingArchive,
  onOpenThreadContextMenu,
  onRequestRenameThread,
  nowTick,
  threadTagsById,
}: {
  orderedGroups: ProjectGroup[];
  draggingWorkspaceId: string | null;
  dropIndex: number | null;
  onWorkspaceOrderChange?: (workspaceIds: string[]) => Promise<void> | void;
  workspaceRowRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onWorkspacePointerDown: (
    workspaceId: string,
    event: React.PointerEvent<HTMLDivElement>,
  ) => void;
  onWorkspacePointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onWorkspacePointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onWorkspaceClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void;
  visualSelectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string, threadId: string | null) => void;
  onNewThread?: (workspaceId: string) => void;
  onSearchProjectThreads?: (workspaceId: string) => void;
  canOpenWorkspaceContextMenu: boolean;
  onOpenWorkspaceContextMenu: (
    workspaceId: string,
    path: string,
    position: { x: number; y: number },
  ) => void;
  workspaceColors?: Record<string, string>;
  workspaceHosts?: Record<string, WorkspaceHostBadge>;
  collapsedWorkspaces: ReadonlySet<string>;
  onWorkspaceOpenChange: (workspaceId: string, open: boolean) => void;
  threadSort: ThreadSortMode;
  visualSelectedThreadId: string | null;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onArchiveThread?: ThreadItemArchiveHandler;
  onArchiveConfirm?: () => void;
  onArchiveCancel?: () => void;
  pendingArchive?: { workspaceId: string; threadId: string } | null;
  onOpenThreadContextMenu?: (args: ThreadContextMenuState) => void;
  onRequestRenameThread?: (args: {
    workspaceId: string;
    thread: ThreadSummary;
  }) => void;
  nowTick: number;
  threadTagsById?: Record<string, ThreadTag[]>;
}) {
  let remainingIndex = 0;
  const remainingWorkspaceIds = orderedGroups
    .map((group) => group.workspace.id)
    .filter((workspaceId) => workspaceId !== draggingWorkspaceId);
  const lastRemainingWorkspaceId = remainingWorkspaceIds.at(-1);

  return (
    <div className="space-y-4">
      {orderedGroups.map((group) => {
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
                if (node) workspaceRowRefs.current.set(workspaceId, node);
                else workspaceRowRefs.current.delete(workspaceId);
              },
              onPointerDown: (event: React.PointerEvent<HTMLDivElement>) =>
                onWorkspacePointerDown(workspaceId, event),
              onPointerMove: onWorkspacePointerMove,
              onPointerUp: onWorkspacePointerUp,
              onPointerCancel: onWorkspacePointerUp,
              onClickCapture: onWorkspaceClickCapture,
              "data-workspace-drag-id": workspaceId,
              "aria-grabbed": isDragged ? true : undefined,
              className: cn(
                "cursor-grab select-none",
                isDragged && "cursor-grabbing opacity-50",
              ),
              style: { touchAction: "none" as const },
            }
          : undefined;

        // Only the collapsed row renders these, but the summary is cheap and
        // the group is memoised on scalars, so it costs nothing when open.
        const attention = summarizeThreadAttention(group.threads);

        return (
          <React.Fragment key={workspaceId}>
            {showDropBefore ? <WorkspaceDropIndicator /> : null}
            <WorkspaceGroup
              workspace={group.workspace}
              host={workspaceHosts?.[workspaceId] ?? null}
              isSelected={visualSelectedWorkspaceId === workspaceId}
              onSelect={() =>
                onSelectWorkspace(
                  workspaceId,
                  group.workspace.current_thread_id ??
                    group.threads[0]?.id ??
                    null,
                )
              }
              onNewThread={
                onNewThread ? () => onNewThread(workspaceId) : undefined
              }
              onSearchThreads={
                onSearchProjectThreads
                  ? () => onSearchProjectThreads(workspaceId)
                  : undefined
              }
              onOpenContextMenu={
                canOpenWorkspaceContextMenu
                  ? (position) =>
                      onOpenWorkspaceContextMenu(
                        workspaceId,
                        group.workspace.path,
                        position,
                      )
                  : undefined
              }
              color={workspaceColors?.[workspaceId] ?? null}
              dragHandleProps={dragHandleProps}
              open={!collapsedWorkspaces.has(workspaceId)}
              onOpenChange={(open) => onWorkspaceOpenChange(workspaceId, open)}
              runningCount={attention.running}
              unreadCount={attention.unread}
              unreadTone={attention.unreadTone}
            >
              <ThreadList
                group={group}
                sortMode={threadSort}
                selectedThreadId={visualSelectedThreadId}
                onSelectThread={onSelectThread}
                onArchiveThread={onArchiveThread}
                onArchiveConfirm={onArchiveConfirm}
                onArchiveCancel={onArchiveCancel}
                pendingArchive={pendingArchive}
                onOpenThreadContextMenu={onOpenThreadContextMenu}
                onRequestRenameThread={onRequestRenameThread}
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
      })}
    </div>
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
  onNewChat,
  onSearchProjectThreads,
  onArchiveThread,
  onDeleteThread,
  onRenameThread,
  onSuggestThreadTitle,
  onForkThread,
  onTogglePinThread,
  onTogglePinThreadInProject,
  onMarkThreadRead,
  onMarkThreadUnread,
  onAddProject,
  onSearch,
  newThreadShortcut,
  addProjectShortcut,
  searchShortcut,
  onRemoveWorkspace,
  onCloseWorkspace,
  closeWorkspaceReason,
  libraryWorkspaces = [],
  onOpenLibraryWorkspace,
  workspaceColors,
  onWorkspaceColorChange,
  threadSort = "last_updated",
  onThreadSortChange,
  onWorkspaceOrderChange,
  collapsedWorkspaceIds,
  onWorkspaceCollapsedChange,
  projectsCollapsed: projectsCollapsedProp,
  onProjectsCollapsedChange,
  chatsCollapsed: chatsCollapsedProp,
  onChatsCollapsedChange,
  isAddingProject = false,
  title,
  errors = [],
  onDismissError,
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
  const [uncontrolledProjectsCollapsed, setUncontrolledProjectsCollapsed] =
    useState(false);
  const [uncontrolledChatsCollapsed, setUncontrolledChatsCollapsed] =
    useState(false);
  const [selectedExtensionFilterValues, setSelectedExtensionFilterValues] =
    useState<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map());
  const [threadContextMenu, setThreadContextMenu] =
    useState<ThreadContextMenuState | null>(null);
  // Archive asks before it acts: the target row dims and shows a Confirm pill
  // until the user confirms, dismisses, or clicks elsewhere.
  const [pendingArchive, setPendingArchiveState] = useState<{
    workspaceId: string;
    threadId: string;
  } | null>(null);
  const pendingArchiveRef = useRef<{
    workspaceId: string;
    threadId: string;
  } | null>(null);
  const updatePendingArchive = useCallback(
    (next: { workspaceId: string; threadId: string } | null) => {
      pendingArchiveRef.current = next;
      setPendingArchiveState(next);
    },
    [],
  );
  const [renameTarget, setRenameTarget] = useState<{
    workspaceId: string;
    thread: ThreadSummary;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenamingThread, setIsRenamingThread] = useState(false);
  const [isSuggestingTitle, setIsSuggestingTitle] = useState(false);
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
  const [closeTarget, setCloseTarget] = useState<{
    workspaceId: string;
    path: string;
    reason: string | null;
  } | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [isClosingWorkspace, setIsClosingWorkspace] = useState(false);
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

  const chatGroups = useMemo(
    () => displayGroups.filter((group) => group.workspace.kind === "casual"),
    [displayGroups],
  );
  const projectDisplayGroups = useMemo(
    () => displayGroups.filter((group) => group.workspace.kind !== "casual"),
    [displayGroups],
  );
  const chatEntries = useMemo(() => {
    const compare = compareThreads(threadSort);
    return chatGroups
      .flatMap((group) =>
        group.threads
          .filter((thread) => !thread.is_pinned)
          .map((thread) => ({ workspaceId: group.workspace.id, thread })),
      )
      .sort((left, right) => {
        const pinDelta =
          Number(right.thread.is_pinned_in_project) -
          Number(left.thread.is_pinned_in_project);
        return pinDelta || compare(left.thread, right.thread);
      });
  }, [chatGroups, threadSort]);
  const orderedGroups = useMemo(() => {
    if (!optimisticWorkspaceOrder) return projectDisplayGroups;
    const groupsById = new Map(
      projectDisplayGroups.map((group) => [group.workspace.id, group]),
    );
    const orderedIds = [
      ...optimisticWorkspaceOrder,
      ...projectDisplayGroups.map((group) => group.workspace.id),
    ];
    const seen = new Set<string>();
    return orderedIds.flatMap((workspaceId) => {
      if (seen.has(workspaceId)) return [];
      seen.add(workspaceId);
      const group = groupsById.get(workspaceId);
      return group ? [group] : [];
    });
  }, [optimisticWorkspaceOrder, projectDisplayGroups]);

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

  const projectsCollapsed = onProjectsCollapsedChange
    ? Boolean(projectsCollapsedProp)
    : uncontrolledProjectsCollapsed;

  const chatsCollapsed = onChatsCollapsedChange
    ? Boolean(chatsCollapsedProp)
    : uncontrolledChatsCollapsed;

  const handleProjectsCollapsedChange = useCallback(
    (collapsed: boolean) => {
      if (onProjectsCollapsedChange) {
        onProjectsCollapsedChange(collapsed);
        return;
      }
      setUncontrolledProjectsCollapsed(collapsed);
    },
    [onProjectsCollapsedChange],
  );

  const handleToggleProjects = useCallback(() => {
    handleProjectsCollapsedChange(!projectsCollapsed);
  }, [handleProjectsCollapsedChange, projectsCollapsed]);

  const handleChatsCollapsedChange = useCallback(
    (collapsed: boolean) => {
      if (onChatsCollapsedChange) {
        onChatsCollapsedChange(collapsed);
        return;
      }
      setUncontrolledChatsCollapsed(collapsed);
    },
    [onChatsCollapsedChange],
  );

  const handleToggleChats = useCallback(() => {
    handleChatsCollapsedChange(!chatsCollapsed);
  }, [chatsCollapsed, handleChatsCollapsedChange]);

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
    if (isRenamingThread || isSuggestingTitle) return;
    resetRenameDialog();
  }, [isRenamingThread, isSuggestingTitle, resetRenameDialog]);

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
        !onForkThread &&
        !onTogglePinThread &&
        !onTogglePinThreadInProject &&
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
      onForkThread,
      onMarkThreadRead,
      onMarkThreadUnread,
      onRenameThread,
      onSetThreadStage,
      onTogglePinThread,
      onTogglePinThreadInProject,
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

  const requestArchiveConfirm = useCallback(
    (workspaceId: string, threadId: string) => {
      updatePendingArchive({ workspaceId, threadId });
    },
    [updatePendingArchive],
  );

  const cancelArchiveConfirm = useCallback(() => {
    updatePendingArchive(null);
  }, [updatePendingArchive]);

  const confirmArchive = useCallback(() => {
    const pending = pendingArchiveRef.current;
    updatePendingArchive(null);
    if (!pending || !onArchiveThread) return;
    void Promise.resolve(
      onArchiveThread(pending.workspaceId, pending.threadId),
    ).catch(() => {});
  }, [onArchiveThread, updatePendingArchive]);

  useEffect(() => {
    if (!pendingArchive) return;
    // Any press outside the confirming row, or Escape, backs out. Presses on
    // the row itself are left to the row (click = dismiss, pill = confirm).
    const handlePointerDown = (event: PointerEvent) => {
      const { target } = event;
      if (
        target instanceof Element &&
        target.closest('[data-archive-confirm="true"]')
      ) {
        return;
      }
      updatePendingArchive(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") updatePendingArchive(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [pendingArchive, updatePendingArchive]);

  const handleArchiveFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onArchiveThread) return;
    const { workspaceId, thread } = threadContextMenu;
    setThreadContextMenu(null);
    requestArchiveConfirm(workspaceId, thread.id);
  }, [requestArchiveConfirm, threadContextMenu]);

  const handleStartRenameFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onRenameThread) return;
    openRenameDialog(threadContextMenu.workspaceId, threadContextMenu.thread);
  }, [onRenameThread, openRenameDialog, threadContextMenu]);

  const handleForkFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onForkThread) return;
    const { workspaceId, thread } = threadContextMenu;
    setThreadContextMenu(null);
    void Promise.resolve(onForkThread(workspaceId, thread.id)).catch(() => {});
  }, [onForkThread, threadContextMenu]);

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

  const handleTogglePinInProjectFromContextMenu = useCallback(() => {
    if (!threadContextMenu || !onTogglePinThreadInProject) return;
    const { workspaceId, thread } = threadContextMenu;
    setThreadContextMenu(null);
    void Promise.resolve(
      onTogglePinThreadInProject(
        workspaceId,
        thread.id,
        !thread.is_pinned_in_project,
      ),
    ).catch(() => {});
  }, [onTogglePinThreadInProject, threadContextMenu]);

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
      if (!onRemoveWorkspace && !onCloseWorkspace && !onWorkspaceColorChange)
        return;
      setThreadContextMenu(null);
      setWorkspaceContextMenu({
        workspaceId,
        path,
        x: position.x,
        y: position.y,
      });
    },
    [onCloseWorkspace, onRemoveWorkspace, onWorkspaceColorChange],
  );

  const handleSetWorkspaceColor = useCallback(
    (color: WorkspaceColorId | null) => {
      if (!workspaceContextMenu || !onWorkspaceColorChange) return;
      const { workspaceId } = workspaceContextMenu;
      setWorkspaceContextMenu(null);
      void onWorkspaceColorChange(workspaceId, color);
    },
    [onWorkspaceColorChange, workspaceContextMenu],
  );

  const requestCloseWorkspace = useCallback(() => {
    if (!workspaceContextMenu || !onCloseWorkspace) return;
    const { workspaceId, path } = workspaceContextMenu;
    setWorkspaceContextMenu(null);
    const reason = closeWorkspaceReason?.(workspaceId) ?? null;
    if (reason) {
      setCloseError(null);
      setCloseTarget({ workspaceId, path, reason });
      return;
    }
    void Promise.resolve(onCloseWorkspace(workspaceId)).catch(() => {});
  }, [closeWorkspaceReason, onCloseWorkspace, workspaceContextMenu]);

  const closeCloseDialog = useCallback(() => {
    if (isClosingWorkspace) return;
    setCloseTarget(null);
    setCloseError(null);
  }, [isClosingWorkspace]);

  const handleConfirmCloseWorkspace = useCallback(async () => {
    if (!closeTarget || !onCloseWorkspace) return;
    setIsClosingWorkspace(true);
    setCloseError(null);
    try {
      await onCloseWorkspace(closeTarget.workspaceId);
      setCloseTarget(null);
    } catch (error) {
      setCloseError(
        error instanceof Error ? error.message : "Failed to close project",
      );
    } finally {
      setIsClosingWorkspace(false);
    }
  }, [closeTarget, onCloseWorkspace]);

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
            providerLabel: threadProviderLabel(group.workspace, thread),
          })),
      ),
    [displayGroups],
  );
  const stablePinnedThreads = useStablePriorityOrder(
    pinnedCandidates,
    threadSort === "priority",
    pinnedEntryKey,
    pinnedEntryThread,
  );
  const stablePinnedRecency = useStableRecencyOrder(
    pinnedCandidates,
    threadSort === "last_updated",
    pinnedEntryKey,
    pinnedEntryThread,
  );
  const pinnedThreads = useMemo(() => {
    if (threadSort === "priority") return stablePinnedThreads;
    if (threadSort === "last_updated") return stablePinnedRecency;
    const compare = compareThreads(threadSort);
    return [...pinnedCandidates].sort((left, right) =>
      compare(left.thread, right.thread),
    );
  }, [pinnedCandidates, stablePinnedRecency, stablePinnedThreads, threadSort]);

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
    onNewChat || (onNewThread && newThreadWorkspaceId) ? (
      <Tooltip label={onNewChat ? "New chat" : "New thread"} shortcut={newThreadShortcut}>
        <button
          type="button"
          onClick={() => {
            if (onNewChat) void onNewChat();
            else if (newThreadWorkspaceId) handleNewThread(newThreadWorkspaceId);
          }}
          className="fd-focus group mb-1 flex w-full items-center gap-1.5 rounded-[var(--fd-radius-md)] py-1.5 pl-1.5 pr-3 text-left text-[length:var(--fd-text-sm)] font-medium text-fg-primary transition-colors hover:bg-surface-3"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-secondary transition-colors group-hover:bg-surface-4 group-hover:text-fg-primary">
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">{onNewChat ? "New chat" : "New thread"}</span>
          {newThreadShortcut?.length ? (
            <span
              aria-hidden="true"
              className="fd-readout shrink-0 text-[length:var(--fd-text-xs)] text-fg-muted"
            >
              {newThreadShortcut.join("")}
            </span>
          ) : null}
        </button>
      </Tooltip>
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

  const handleSuggestTitle = useCallback(async () => {
    if (!renameTarget || !onSuggestThreadTitle || isSuggestingTitle) return;

    setIsSuggestingTitle(true);
    setRenameError(null);
    try {
      const title = await onSuggestThreadTitle(
        renameTarget.workspaceId,
        renameTarget.thread.id,
      );
      const nextTitle = title.trim();
      if (!nextTitle) {
        setRenameError("Couldn't generate a title");
        return;
      }
      setRenameValue(nextTitle);
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : "Couldn't generate a title",
      );
    } finally {
      setIsSuggestingTitle(false);
    }
  }, [isSuggestingTitle, onSuggestThreadTitle, renameTarget]);

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
      if (event.key !== "Escape" || isRenamingThread || isSuggestingTitle) return;
      resetRenameDialog();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isRenamingThread, isSuggestingTitle, renameTarget, resetRenameDialog]);

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

  const visibleErrors = errors.filter(Boolean);
  const showHeader =
    Boolean(title) || Boolean(onSearch) || Boolean(headerClassName);

  return (
    <SidebarShell className={className}>
      {showHeader ? (
        <SidebarHeader
          className={headerClassName}
          // Restores window dragging over the traffic-light row on desktop.
          data-tauri-drag-region="deep"
        >
          {title || onSearch ? (
            <div
              className={
                title
                  ? "flex items-center justify-between"
                  : "flex items-center justify-end"
              }
            >
              {title ? (
                <span className="text-[length:var(--fd-text-sm)] text-fg-muted">
                  {title}
                </span>
              ) : null}
              {onSearch ? (
                <Tooltip label="Search" shortcut={searchShortcut}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={onSearch}
                    aria-label="Search"
                  >
                    <Search aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
        </SidebarHeader>
      ) : null}

      <SidebarContent className={contentClassName}>
        {visibleErrors.length > 0 ? (
          // Errors sit in the scrolling body, not the titlebar row: that row
          // is a fixed-height drag region beside the traffic lights, so a
          // wrapped message used to collide with the window controls.
          <div className="mb-3 flex flex-col gap-2" role="status">
            {visibleErrors.map((error) => (
              <div
                key={error}
                className="flex items-start gap-2 rounded-[var(--fd-radius-md)] border border-warning/20 bg-warning-muted px-3 py-2 text-[length:var(--fd-text-xs)] text-warning"
              >
                <span className="min-w-0 flex-1 break-words">{error}</span>
                {onDismissError ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="-mr-1 -mt-0.5 h-5 w-5 shrink-0 text-warning hover:text-warning"
                    onClick={() => {
                      onDismissError(error);
                    }}
                    aria-label="Dismiss error"
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
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
          onArchiveThread={requestArchiveConfirm}
          onArchiveConfirm={confirmArchive}
          onArchiveCancel={cancelArchiveConfirm}
          pendingArchive={pendingArchive}
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
          {/* The action icons match the per-project new-thread button: that
              glyph sits 10px from the sidebar edge (px-2 row + p-0.5 button).
              These heading buttons use the same padding, so the trailing
              gutter is pr-2. */}
          <div className="flex items-center justify-between pb-1.5 pl-2.5 pr-2">
            <h2 id="fd-projects-heading">
              {orderedGroups.length > 0 ? (
                <button
                  type="button"
                  className={cn(
                    "group/projects",
                    SIDEBAR_SECTION_HEADING_BUTTON_CLASS,
                  )}
                  onClick={handleToggleProjects}
                  aria-expanded={!projectsCollapsed}
                  aria-label={
                    projectsCollapsed ? "Expand projects" : "Collapse projects"
                  }
                  title={
                    projectsCollapsed ? "Expand projects" : "Collapse projects"
                  }
                >
                  Projects
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 opacity-0 transition-[transform,opacity] duration-[var(--fd-duration-fast)] group-hover/projects:opacity-100 group-focus-visible/projects:opacity-100",
                      projectsCollapsed && "-rotate-90",
                    )}
                  />
                </button>
              ) : (
                <span className={SIDEBAR_SECTION_HEADING_LABEL_CLASS}>
                  Projects
                </span>
              )}
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
                libraryWorkspaces.length > 0 && onOpenLibraryWorkspace ? (
                  <AddProjectMenu
                    libraryWorkspaces={libraryWorkspaces}
                    onOpenLibraryWorkspace={onOpenLibraryWorkspace}
                    onAddProject={onAddProject}
                    isAddingProject={isAddingProject}
                    shortcut={addProjectShortcut}
                  />
                ) : (
                  <Tooltip label="Add project" shortcut={addProjectShortcut}>
                    <button
                      type="button"
                      className={SIDEBAR_SECTION_ICON_BUTTON_CLASS}
                      onClick={onAddProject}
                      disabled={isAddingProject}
                      aria-label="Add project"
                      aria-busy={isAddingProject}
                    >
                      {isAddingProject ? (
                        <ActivityDiamond size="sm" tone="current" />
                      ) : (
                        <FolderPlus aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </Tooltip>
                )
              ) : null}
            </div>
          </div>
          <Collapsible.Root open={!projectsCollapsed}>
            <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapse-fast data-[state=open]:animate-expand-fast">
              <ProjectGroupList
                orderedGroups={orderedGroups}
                draggingWorkspaceId={draggingWorkspaceId}
                dropIndex={dropIndex}
                onWorkspaceOrderChange={onWorkspaceOrderChange}
                workspaceRowRefs={workspaceRowRefs}
                onWorkspacePointerDown={handleWorkspacePointerDown}
                onWorkspacePointerMove={handleWorkspacePointerMove}
                onWorkspacePointerUp={finishWorkspaceDrag}
                onWorkspaceClickCapture={handleWorkspaceClickCapture}
                visualSelectedWorkspaceId={visualSelectedWorkspaceId}
                onSelectWorkspace={handleSelectWorkspace}
                onNewThread={onNewThread ? handleNewThread : undefined}
                onSearchProjectThreads={onSearchProjectThreads}
                canOpenWorkspaceContextMenu={Boolean(
                  onRemoveWorkspace ||
                    onCloseWorkspace ||
                    onWorkspaceColorChange,
                )}
                onOpenWorkspaceContextMenu={handleOpenWorkspaceContextMenu}
                workspaceColors={workspaceColors}
                workspaceHosts={workspaceHosts}
                collapsedWorkspaces={collapsedWorkspaces}
                onWorkspaceOpenChange={handleWorkspaceOpenChange}
                threadSort={threadSort}
                visualSelectedThreadId={visualSelectedThreadId}
                onSelectThread={handleSelectThread}
                onArchiveThread={requestArchiveConfirm}
                onArchiveConfirm={confirmArchive}
                onArchiveCancel={cancelArchiveConfirm}
                pendingArchive={pendingArchive}
                onOpenThreadContextMenu={handleOpenThreadContextMenu}
                onRequestRenameThread={handleRequestRenameThread}
                nowTick={nowTick}
                threadTagsById={threadTagsById}
              />
            </Collapsible.Content>
          </Collapsible.Root>
          {orderedGroups.length === 0 && chatGroups.length === 0 ? (
            <EmptyState
              icon={
                onAddProject ? <FolderPlus className="h-5 w-5" /> : undefined
              }
              title={emptyState.title}
              description={emptyState.description}
            />
          ) : null}
        </section>
        {onNewChat || chatEntries.length > 0 ? (
          <section aria-labelledby="fd-chats-heading" className="mt-4">
            <div className="flex items-center justify-between pb-1.5 pl-2.5 pr-2">
              <h2 id="fd-chats-heading">
                {chatEntries.length > 0 ? (
                  <button
                    type="button"
                    className={cn(
                      "group/chats",
                      SIDEBAR_SECTION_HEADING_BUTTON_CLASS,
                    )}
                    onClick={handleToggleChats}
                    aria-expanded={!chatsCollapsed}
                    aria-label={
                      chatsCollapsed ? "Expand chats" : "Collapse chats"
                    }
                    title={chatsCollapsed ? "Expand chats" : "Collapse chats"}
                  >
                    Chats
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 opacity-0 transition-[transform,opacity] duration-[var(--fd-duration-fast)] group-hover/chats:opacity-100 group-focus-visible/chats:opacity-100",
                        chatsCollapsed && "-rotate-90",
                      )}
                    />
                  </button>
                ) : (
                  <span className={SIDEBAR_SECTION_HEADING_LABEL_CLASS}>
                    Chats
                  </span>
                )}
              </h2>
              {onNewChat ? (
                <Tooltip label="Start new chat">
                  <button
                    type="button"
                    className={SIDEBAR_SECTION_ICON_BUTTON_CLASS}
                    onClick={() => void onNewChat()}
                    aria-label="Start new chat"
                  >
                    <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              ) : null}
            </div>
            <Collapsible.Root open={!chatsCollapsed}>
              <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapse-fast data-[state=open]:animate-expand-fast">
                {chatEntries.map(({ workspaceId, thread }) => (
                  <ThreadItem
                    key={`${workspaceId}:${thread.id}`}
                    thread={thread}
                    workspaceId={workspaceId}
                    isSelected={visualSelectedThreadId === thread.id}
                    onSelect={handleSelectThread}
                    onArchive={requestArchiveConfirm}
                    archiveConfirmPending={Boolean(
                      pendingArchive &&
                        pendingArchive.workspaceId === workspaceId &&
                        pendingArchive.threadId === thread.id,
                    )}
                    onArchiveConfirm={confirmArchive}
                    onArchiveCancel={cancelArchiveConfirm}
                    onOpenContextMenu={handleOpenThreadContextMenu}
                    onRequestRename={handleRequestRenameThread}
                    nowTick={nowTick}
                    tags={threadTagsById?.[thread.id]}
                  />
                ))}
              </Collapsible.Content>
            </Collapsible.Root>
          </section>
        ) : null}
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
        canFork={Boolean(onForkThread)}
        canArchive={Boolean(onArchiveThread)}
        canDelete={Boolean(onDeleteThread)}
        canPin={Boolean(onTogglePinThread)}
        canPinInProject={
          Boolean(onTogglePinThreadInProject) &&
          threadContextMenu != null &&
          groups.find(
            (group) => group.workspace.id === threadContextMenu.workspaceId,
          )?.workspace.kind !== "casual"
        }
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
        onFork={handleForkFromContextMenu}
        onArchive={handleArchiveFromContextMenu}
        onDelete={openDeleteDialog}
        onTogglePin={handleTogglePinFromContextMenu}
        onTogglePinInProject={handleTogglePinInProjectFromContextMenu}
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
        suggesting={isSuggestingTitle}
        onChange={setRenameValue}
        onClose={closeRenameDialog}
        onSubmit={handleRenameSubmit}
        onSuggestTitle={onSuggestThreadTitle ? handleSuggestTitle : undefined}
      />
      <WorkspaceContextMenu
        menuRef={workspaceContextMenuRef}
        target={workspaceContextMenu}
        selectedColor={
          workspaceContextMenu
            ? (workspaceColors?.[workspaceContextMenu.workspaceId] ?? null)
            : null
        }
        onSetColor={onWorkspaceColorChange ? handleSetWorkspaceColor : undefined}
        onCloseFromSidebar={
          onCloseWorkspace ? requestCloseWorkspace : undefined
        }
        onRemove={onRemoveWorkspace ? openRemoveDialog : undefined}
      />
      <CloseWorkspaceDialog
        target={closeTarget}
        reason={closeTarget?.reason ?? null}
        error={closeError}
        pending={isClosingWorkspace}
        onClose={closeCloseDialog}
        onConfirm={handleConfirmCloseWorkspace}
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
              className="fd-type-supporting pointer-events-none fixed z-[100] flex max-w-64 items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-2.5 py-1.5 text-fg-primary shadow-[var(--fd-shadow-lg)]"
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
