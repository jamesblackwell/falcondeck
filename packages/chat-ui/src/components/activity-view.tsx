import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Activity, PanelsTopLeft, Plus } from "lucide-react";

import {
  collectActivityEntries,
  collectRecentEntries,
  type ActivityEntry,
  type ActivitySection,
  type InteractiveRequest,
  type InteractiveResponsePayload,
  type ProjectGroup,
  type RecentEntry,
} from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Button,
  EmptyState,
  Kbd,
  MainView,
  MainViewBody,
  MainViewSection,
  cn,
} from "@falcondeck/ui";

import {
  ActivityPreview,
  type ActivityPreviewActions,
} from "./activity-preview";
import { InteractiveRequestCard } from "./interactive-request-card";

const RELATIVE_TIME_TICK_MS = 60_000;
const RESOLVED_HOLD_MS = 1_500;
const RECENT_PREVIEW_LIMIT = 5;
const RECENT_TOGGLE_KEY = "recent:toggle";
/** Needs you, then what is still going. Finished work is grouped separately. */
const SECTION_ORDER: readonly ActivitySection[] = [
  "blocked",
  "failed",
  "running",
];

export type ActivityViewProps = {
  onLoadPreview?: ActivityPreviewActions["onLoadPreview"];
  onSendPreview?: ActivityPreviewActions["onSendPreview"];
  groups: ProjectGroup[];
  interactiveRequests: InteractiveRequest[];
  workspaceHosts?: Record<string, { name: string; connected: boolean }>;
  onOpenThread: (workspaceId: string, threadId: string) => void;
  onInteractiveResponse: (
    request: InteractiveRequest,
    response: InteractiveResponsePayload,
  ) => Promise<void>;
  onMarkThreadRead: (
    workspaceId: string,
    threadId: string,
    readSeq?: number,
  ) => Promise<void> | void;
  /** Omitted when Activity owns its window — the frame closes it instead. */
  onClose?: () => void;
  onNewThread?: () => void;
  /** Detach Activity into its own window. Absent once it is detached. */
  onPopOut?: () => void;
  /** Pad the header clear of macOS traffic lights in a detached window. */
  trafficLightInset?: boolean;
  /** Window-level controls (pin, and anything else the frame owns). */
  headerActions?: ReactNode;
  /**
   * Hand keyboard focus back to the main app. Present only when Activity owns
   * a window, where Escape means "go back to what I was doing", not "close".
   */
  onReturnFocus?: () => void;
  /**
   * Whether this window has OS focus. Undefined in the takeover, which is
   * focused whenever the app is.
   */
  windowFocused?: boolean;
};

type ResolvedEntry = {
  entry: ActivityEntry;
  request: InteractiveRequest;
};

const SECTION_META: Record<ActivitySection, { title: string }> = {
  blocked: { title: "Needs a response" },
  failed: { title: "Failed" },
  ready: { title: "Ready" },
  running: { title: "Working" },
};

const KEY_HINTS: readonly {
  key: string;
  alt?: string;
  description: string;
}[] = [
  { key: "↑ ↓", alt: "J / K", description: "Move through the list" },
  { key: "↵", description: "Preview the selected task" },
  { key: "R", description: "Mark the selected task read" },
  { key: "T", description: "Show more finished tasks" },
  { key: "?", description: "Show keyboard shortcuts" },
  { key: "esc", description: "Clear the selection" },
];

function threadIdentity(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`;
}

function entryKey(entry: ActivityEntry) {
  return threadIdentity(entry.workspaceId, entry.thread.id);
}

function recentKey(entry: RecentEntry) {
  return `recent:${threadIdentity(entry.workspaceId, entry.thread.id)}`;
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

function isActivatableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button, a[href], summary"));
}

function timeAgo(dateStr: string, nowMs: number) {
  const seconds = Math.max(
    0,
    Math.floor((nowMs - new Date(dateStr).getTime()) / 1000),
  );
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function mergeResolvedEntries(
  entries: ActivityEntry[],
  resolvedEntries: Record<string, ResolvedEntry>,
) {
  const freshBlockedKeys = new Set(
    entries.filter((entry) => entry.section === "blocked").map(entryKey),
  );
  const merged = entries.filter((entry) => {
    const resolved = resolvedEntries[entryKey(entry)];
    return !resolved || entry.section === "blocked";
  });

  for (const [key, resolved] of Object.entries(resolvedEntries)) {
    if (!freshBlockedKeys.has(key)) merged.push(resolved.entry);
  }
  return merged;
}

function resolvedRequestForEntry(
  entry: ActivityEntry,
  resolvedEntry: ResolvedEntry | undefined,
) {
  if (!resolvedEntry) return undefined;
  const currentRequest = entry.requests[0];
  return !currentRequest ||
    currentRequest.request_id === resolvedEntry.request.request_id
    ? resolvedEntry.request
    : undefined;
}

/** Insert keys from `desired` that `order` does not already have, beside their neighbors. */
function placeNewKeys(order: string[], desired: readonly string[]) {
  const placed = new Set(order);
  for (let desiredIndex = 0; desiredIndex < desired.length; desiredIndex += 1) {
    const key = desired[desiredIndex];
    if (!key || placed.has(key)) continue;

    let insertionIndex = -1;
    for (let index = desiredIndex - 1; index >= 0; index -= 1) {
      const precedingKey = desired[index];
      if (precedingKey && placed.has(precedingKey)) {
        insertionIndex = order.indexOf(precedingKey) + 1;
        break;
      }
    }
    if (insertionIndex === -1) {
      for (let index = desiredIndex + 1; index < desired.length; index += 1) {
        const followingKey = desired[index];
        if (followingKey && placed.has(followingKey)) {
          insertionIndex = order.indexOf(followingKey);
          break;
        }
      }
    }

    if (insertionIndex === -1) order.push(key);
    else order.splice(insertionIndex, 0, key);
    placed.add(key);
  }
  return order;
}

function reconcileStableKeys(previousKeys: string[], entries: ActivityEntry[]) {
  const desiredKeys = entries.map(entryKey);
  const currentKeys = new Set(desiredKeys);
  return placeNewKeys(
    previousKeys.filter((key) => currentKeys.has(key)),
    desiredKeys,
  );
}

function useStableOrder(entries: ActivityEntry[]) {
  const orderRef = useRef(new Map<string, string[]>());
  const bySection = new Map<ActivitySection, ActivityEntry[]>();
  for (const entry of entries) {
    const sectionEntries = bySection.get(entry.section) ?? [];
    sectionEntries.push(entry);
    bySection.set(entry.section, sectionEntries);
  }

  // Running stays in recency order so the task that just moved sits at the top.
  for (const section of ["blocked", "failed", "ready"] as const) {
    const sectionEntries = bySection.get(section) ?? [];
    const order = reconcileStableKeys(
      orderRef.current.get(section) ?? [],
      sectionEntries,
    );
    orderRef.current.set(section, order);
    const rank = new Map(order.map((key, index) => [key, index]));
    sectionEntries.sort(
      (left, right) =>
        (rank.get(entryKey(left)) ?? 0) - (rank.get(entryKey(right)) ?? 0),
    );
  }

  return bySection;
}

function requestsEqual(
  left: InteractiveRequest[],
  right: InteractiveRequest[],
) {
  return (
    left.length === right.length &&
    left.every((request, index) => {
      const other = right[index];
      return (
        request.request_id === other?.request_id &&
        request.created_at === other?.created_at
      );
    })
  );
}

function previewForEntry(entry: ActivityEntry) {
  if (entry.section === "failed") {
    return entry.thread.last_error ?? "The run failed";
  }
  if (entry.section === "ready") {
    return entry.thread.last_message_preview ?? "Turn finished";
  }
  if (entry.section === "blocked") return null;
  return (
    entry.thread.last_tool ?? entry.thread.last_message_preview ?? "Working…"
  );
}

function ToneMark({ section }: { section?: ActivitySection }) {
  if (!section) {
    return <span className="h-4 w-4 shrink-0" />;
  }
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {section === "running" ? (
        <ActivityDiamond size="xs" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "h-2 w-2 rounded-full",
            section === "blocked" &&
              "bg-warning shadow-[0_0_0_3px_var(--fd-warning-muted)]",
            section === "failed" && "bg-danger",
            section === "ready" && "bg-unread",
          )}
        />
      )}
    </span>
  );
}

type InboxRowProps = {
  activityKey: string;
  threadId?: string;
  title: string;
  preview?: string | null;
  projectLabel: string;
  host?: { name: string; connected: boolean };
  timeLabel: string;
  queued?: number;
  section?: ActivitySection;
  /** Unread finished work. Settled rows stay in place, but drop the weight. */
  unread?: boolean;
  selected: boolean;
  onOpen: () => void;
  onActivate?: () => void;
  onMarkRead?: () => void;
  children?: ReactNode;
};

const InboxRow = memo(function InboxRow({
  activityKey,
  threadId,
  title,
  preview,
  projectLabel,
  host,
  timeLabel,
  queued = 0,
  section,
  unread = false,
  selected,
  onOpen,
  onActivate,
  onMarkRead,
  children,
}: InboxRowProps) {
  const offline = host?.connected === false;
  const hostLabel = host ? `${host.name}${offline ? " · Offline" : ""}` : null;

  return (
    <article
      className={cn(
        "group rounded-[var(--fd-radius-md)] transition-colors duration-[var(--fd-duration-hover)]",
        selected ? "fd-row-selected" : "hover:bg-interactive-hover",
        offline && "opacity-60",
      )}
      data-activity-thread={threadId}
      data-activity-key={activityKey}
      data-selected={selected ? "true" : undefined}
    >
      <div className="flex items-start gap-2.5 px-2.5 py-2">
        <span className="mt-0.5">
          <ToneMark section={section} />
        </span>
        <button
          type="button"
          onClick={onOpen}
          onDoubleClick={onActivate}
          onKeyDown={(event) => {
            if (onActivate && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              event.stopPropagation();
              onActivate();
            }
          }}
          className="fd-focus-inset min-w-0 flex-1 text-left"
        >
          <span className="flex items-baseline gap-3">
            <span
              className={cn(
                "fd-type-supporting min-w-0 flex-1 truncate",
                unread && "font-semibold",
                selected || unread
                  ? "text-fg-primary"
                  : "text-fg-secondary group-hover:text-fg-primary",
              )}
            >
              {title}
            </span>
            <span className="fd-type-meta shrink-0 tabular-nums text-fg-muted">
              {timeLabel}
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2">
            {preview ? (
              <span
                className="fd-type-meta min-w-0 flex-1 truncate text-fg-muted"
                title={preview}
              >
                {preview}
              </span>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            {queued > 0 ? (
              <span className="fd-type-meta shrink-0 text-fg-muted">
                +{queued} queued
              </span>
            ) : null}
            <span className="fd-type-meta shrink-0 truncate text-fg-muted">
              {projectLabel}
            </span>
            {hostLabel ? (
              <span
                className={cn(
                  "fd-type-meta shrink-0 truncate",
                  offline ? "text-danger" : "text-fg-muted",
                )}
              >
                {hostLabel}
              </span>
            ) : null}
          </span>
        </button>
        {onMarkRead ? (
          <span
            className="shrink-0 pt-0.5"
            title={offline ? "Host offline" : undefined}
          >
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={offline}
              className={cn(
                "h-7 px-2 text-fg-muted transition-opacity duration-[var(--fd-duration-fast)]",
                selected
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
              )}
              onClick={onMarkRead}
            >
              Mark read
            </Button>
          </span>
        ) : null}
      </div>
      {children ? <div className="px-2.5 pb-2.5 pl-9">{children}</div> : null}
    </article>
  );
});

type ActivityRowProps = {
  entry: ActivityEntry;
  host?: { name: string; connected: boolean };
  nowMs: number;
  selected: boolean;
  resolvedRequest?: InteractiveRequest;
  onOpenThread: ActivityViewProps["onOpenThread"];
  onActivateThread?: ActivityViewProps["onOpenThread"];
  onMarkThreadRead: ActivityViewProps["onMarkThreadRead"];
  onRespond: (
    entry: ActivityEntry,
    request: InteractiveRequest,
    response: InteractiveResponsePayload,
  ) => Promise<void>;
};

const ActivityRow = memo(
  function ActivityRow({
    entry,
    host,
    nowMs,
    selected,
    resolvedRequest,
    onOpenThread,
    onActivateThread,
    onMarkThreadRead,
    onRespond,
  }: ActivityRowProps) {
    const offline = host?.connected === false;
    const request = resolvedRequest ?? entry.requests[0];
    const canMarkRead = entry.section === "failed" || entry.section === "ready";

    return (
      <InboxRow
        activityKey={entryKey(entry)}
        threadId={entry.thread.id}
        title={entry.thread.title}
        preview={previewForEntry(entry)}
        projectLabel={entry.projectLabel}
        host={host}
        timeLabel={timeAgo(entry.thread.updated_at, nowMs)}
        queued={entry.thread.queued_turns.length}
        section={entry.section}
        selected={selected}
        onOpen={() => onOpenThread(entry.workspaceId, entry.thread.id)}
        onActivate={
          onActivateThread
            ? () => onActivateThread(entry.workspaceId, entry.thread.id)
            : undefined
        }
        onMarkRead={
          canMarkRead
            ? () => {
                void Promise.resolve(
                  onMarkThreadRead(entry.workspaceId, entry.thread.id),
                ).catch(() => {});
              }
            : undefined
        }
      >
        {entry.section === "blocked" ? (
          <div title={offline ? "Host offline" : undefined}>
            {request ? (
              <fieldset disabled={offline} className="m-0 min-w-0 border-0 p-0">
                <InteractiveRequestCard
                  key={request.request_id}
                  request={request}
                  pendingCount={entry.requests.length}
                  resolved={resolvedRequest?.request_id === request.request_id}
                  onRespond={
                    resolvedRequest
                      ? undefined
                      : (response) => onRespond(entry, request, response)
                  }
                />
              </fieldset>
            ) : (
              <p className="fd-type-supporting text-warning">
                Loading request…
              </p>
            )}
          </div>
        ) : null}
      </InboxRow>
    );
  },
  (previous, next) =>
    previous.entry.section === next.entry.section &&
    previous.entry.workspaceId === next.entry.workspaceId &&
    previous.entry.projectLabel === next.entry.projectLabel &&
    previous.entry.thread.id === next.entry.thread.id &&
    previous.entry.thread.title === next.entry.thread.title &&
    previous.entry.thread.updated_at === next.entry.thread.updated_at &&
    previous.entry.thread.last_error === next.entry.thread.last_error &&
    previous.entry.thread.last_tool === next.entry.thread.last_tool &&
    previous.entry.thread.last_message_preview ===
      next.entry.thread.last_message_preview &&
    previous.entry.thread.queued_turns.length ===
      next.entry.thread.queued_turns.length &&
    requestsEqual(previous.entry.requests, next.entry.requests) &&
    previous.host?.name === next.host?.name &&
    previous.host?.connected === next.host?.connected &&
    previous.nowMs === next.nowMs &&
    previous.selected === next.selected &&
    previous.resolvedRequest?.request_id === next.resolvedRequest?.request_id &&
    previous.onActivateThread === next.onActivateThread &&
    previous.onOpenThread === next.onOpenThread &&
    previous.onMarkThreadRead === next.onMarkThreadRead &&
    previous.onRespond === next.onRespond,
);

type CompletedItem =
  | { kind: "ready"; entry: ActivityEntry; threadKey: string }
  | { kind: "recent"; entry: RecentEntry; threadKey: string };

function readyCompleted(entry: ActivityEntry): CompletedItem {
  return { kind: "ready", entry, threadKey: entryKey(entry) };
}

function recentCompleted(entry: RecentEntry): CompletedItem {
  return {
    kind: "recent",
    entry,
    threadKey: threadIdentity(entry.workspaceId, entry.thread.id),
  };
}

function completedActivityKey(item: CompletedItem) {
  return item.kind === "ready" ? entryKey(item.entry) : recentKey(item.entry);
}

/**
 * Unread finishes sit above settled ones. While the pointer is over the list,
 * a row that was unread stays in that band after it is marked read. Anything
 * else — a new finish, a failure just acknowledged — takes its normal place.
 */
function layoutCompleted({
  hovering,
  expanded,
  ready,
  recent,
  previewLimit,
  readyHold,
}: {
  hovering: boolean;
  expanded: boolean;
  ready: ActivityEntry[];
  recent: RecentEntry[];
  previewLimit: number;
  readyHold: string[] | null;
}): { items: CompletedItem[]; readyHold: string[] | null } {
  const visibleRecent = expanded ? recent : recent.slice(0, previewLimit);
  if (!hovering) {
    return {
      items: [
        ...ready.map(readyCompleted),
        ...visibleRecent.map(recentCompleted),
      ],
      readyHold: null,
    };
  }

  const readyByKey = new Map(ready.map((entry) => [entryKey(entry), entry]));
  const recentByKey = new Map(
    recent.map((entry) => [
      threadIdentity(entry.workspaceId, entry.thread.id),
      entry,
    ]),
  );
  const readyKeys = ready.map(entryKey);
  const alive = (readyHold ?? readyKeys).filter(
    (key) => readyByKey.has(key) || recentByKey.has(key),
  );
  const topKeys = placeNewKeys([...alive], readyKeys);
  const parked = new Set(topKeys);
  const items: CompletedItem[] = [];
  for (const key of topKeys) {
    const readyEntry = readyByKey.get(key);
    if (readyEntry) {
      items.push(readyCompleted(readyEntry));
      continue;
    }
    const recentEntry = recentByKey.get(key);
    if (recentEntry) items.push(recentCompleted(recentEntry));
  }
  for (const entry of visibleRecent) {
    if (!parked.has(threadIdentity(entry.workspaceId, entry.thread.id))) {
      items.push(recentCompleted(entry));
    }
  }
  return { items, readyHold: topKeys };
}

function CompletedTask({
  item,
  host,
  nowMs,
  selected,
  onOpen,
  onActivate,
  onMarkRead,
}: {
  item: CompletedItem;
  host?: { name: string; connected: boolean };
  nowMs: number;
  selected: boolean;
  onOpen: (workspaceId: string, threadId: string) => void;
  onActivate?: (workspaceId: string, threadId: string) => void;
  onMarkRead: ActivityViewProps["onMarkThreadRead"];
}) {
  const { workspaceId, thread } = item.entry;
  const ready = item.kind === "ready";
  return (
    <InboxRow
      activityKey={completedActivityKey(item)}
      threadId={thread.id}
      title={thread.title}
      preview={
        item.kind === "ready"
          ? previewForEntry(item.entry)
          : thread.last_message_preview
      }
      projectLabel={item.entry.projectLabel}
      host={host}
      timeLabel={timeAgo(thread.updated_at, nowMs)}
      queued={thread.queued_turns.length}
      section={ready ? "ready" : undefined}
      unread={ready}
      selected={selected}
      onOpen={() => onOpen(workspaceId, thread.id)}
      onActivate={
        onActivate ? () => onActivate(workspaceId, thread.id) : undefined
      }
      onMarkRead={
        ready
          ? () => {
              void Promise.resolve(onMarkRead(workspaceId, thread.id)).catch(
                () => {},
              );
            }
          : undefined
      }
    />
  );
}

type SelectableRow = {
  key: string;
  section?: ActivitySection;
  entry?: ActivityEntry;
  recent?: RecentEntry;
  action?: "toggle-recent";
};

function rowThreadKey(row: SelectableRow) {
  if (row.entry) return entryKey(row.entry);
  if (row.recent) return threadIdentity(row.recent.workspaceId, row.recent.thread.id);
  return null;
}

/** Keep the highlight when a finished row changes from unread to settled. */
function selectionFor(selectedKey: string | null, rows: readonly SelectableRow[]) {
  if (!selectedKey || rows.some((row) => row.key === selectedKey)) return selectedKey;
  const bare = selectedKey.startsWith("recent:")
    ? selectedKey.slice("recent:".length)
    : selectedKey;
  return rows.find((row) => rowThreadKey(row) === bare)?.key ?? null;
}

export const ActivityView = memo(function ActivityView({
  groups,
  interactiveRequests,
  workspaceHosts = {},
  onOpenThread,
  onLoadPreview,
  onSendPreview,
  onInteractiveResponse,
  onMarkThreadRead,
  onClose,
  onNewThread,
  onPopOut,
  trafficLightInset = false,
  headerActions,
  onReturnFocus,
  windowFocused,
}: ActivityViewProps) {
  const [preview, setPreview] = useState<{
    workspaceId: string;
    threadId: string;
    title: string;
  } | null>(null);
  const [previewDrafts, setPreviewDrafts] = useState<Record<string, string>>(
    {},
  );
  const activateThread = useCallback(
    (workspaceId: string, threadId: string) => {
      if (!onLoadPreview || !onSendPreview)
        return onOpenThread(workspaceId, threadId);
      const target = groups
        .find((group) => group.workspace.id === workspaceId)
        ?.threads.find((thread) => thread.id === threadId);
      if (target) setPreview({ workspaceId, threadId, title: target.title });
    },
    [groups, onLoadPreview, onSendPreview, onOpenThread],
  );
  const selectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      if (!onLoadPreview || !onSendPreview)
        return onOpenThread(workspaceId, threadId);
      const key = `${workspaceId}:${threadId}`;
      const queued = collectActivityEntries(groups, interactiveRequests).some(
        (entry) =>
          entry.workspaceId === workspaceId && entry.thread.id === threadId,
      );
      setSelectedKey(queued ? key : `recent:${key}`);
    },
    [groups, interactiveRequests, onLoadPreview, onSendPreview, onOpenThread],
  );
  const [nowMs, setNowMs] = useState(Date.now);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [listHovered, setListHovered] = useState(false);
  const readyHoldRef = useRef<string[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [resolvedEntries, setResolvedEntries] = useState<
    Record<string, ResolvedEntry>
  >({});
  const resolvedTimeoutsRef = useRef(new Map<string, number>());
  const entries = useMemo(
    () => collectActivityEntries(groups, interactiveRequests),
    [groups, interactiveRequests],
  );

  useEffect(() => {
    const timer = window.setInterval(
      () => setNowMs(Date.now()),
      RELATIVE_TIME_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      for (const timeout of resolvedTimeoutsRef.current.values()) {
        window.clearTimeout(timeout);
      }
    },
    [],
  );

  const handleRespond = useCallback(
    async (
      entry: ActivityEntry,
      request: InteractiveRequest,
      response: InteractiveResponsePayload,
    ) => {
      await onInteractiveResponse(request, response);
      const key = entryKey(entry);
      setResolvedEntries((current) => ({
        ...current,
        [key]: { entry, request },
      }));
      const previousTimeout = resolvedTimeoutsRef.current.get(key);
      if (previousTimeout !== undefined) window.clearTimeout(previousTimeout);
      const timeout = window.setTimeout(() => {
        setResolvedEntries((current) => {
          if (current[key]?.request.request_id !== request.request_id)
            return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
        resolvedTimeoutsRef.current.delete(key);
      }, RESOLVED_HOLD_MS);
      resolvedTimeoutsRef.current.set(key, timeout);
    },
    [onInteractiveResponse],
  );

  const visibleEntries = useMemo(
    () => mergeResolvedEntries(entries, resolvedEntries),
    [entries, resolvedEntries],
  );
  const sections = useStableOrder(visibleEntries);
  const runningCount = sections.get("running")?.length ?? 0;
  const attentionCount = visibleEntries.length - runningCount;

  const recentEntries = useMemo(() => {
    // A resolved request stays on screen briefly. That thread is already in
    // the queue, so it must not also appear under Completed.
    const heldThreadKeys = new Set(Object.keys(resolvedEntries));
    return collectRecentEntries(groups, interactiveRequests, { nowMs }).filter(
      (entry) =>
        !heldThreadKeys.has(threadIdentity(entry.workspaceId, entry.thread.id)),
    );
  }, [groups, interactiveRequests, nowMs, resolvedEntries]);
  const readyEntries = sections.get("ready") ?? [];
  const completedLayout = layoutCompleted({
    hovering: listHovered,
    expanded: recentExpanded,
    ready: readyEntries,
    recent: recentEntries,
    previewLimit: RECENT_PREVIEW_LIMIT,
    readyHold: readyHoldRef.current,
  });
  readyHoldRef.current = completedLayout.readyHold;
  const shownCompletedKeys = new Set(
    completedLayout.items.map((item) => item.threadKey),
  );
  const hiddenFinished = recentEntries.filter(
    (entry) =>
      !shownCompletedKeys.has(
        threadIdentity(entry.workspaceId, entry.thread.id),
      ),
  ).length;
  const showFinishedToggle = recentExpanded
    ? recentEntries.length > RECENT_PREVIEW_LIMIT
    : hiddenFinished > 0;
  const completedCount = readyEntries.length + recentEntries.length;

  const selectable = useMemo(() => {
    const rows: SelectableRow[] = [];
    for (const section of SECTION_ORDER) {
      for (const entry of sections.get(section) ?? []) {
        rows.push({ key: entryKey(entry), section, entry });
      }
    }
    for (const item of completedLayout.items) {
      if (item.kind === "ready") {
        rows.push({
          key: completedActivityKey(item),
          section: "ready",
          entry: item.entry,
        });
      } else {
        rows.push({ key: completedActivityKey(item), recent: item.entry });
      }
    }
    if (showFinishedToggle) {
      rows.push({ key: RECENT_TOGGLE_KEY, action: "toggle-recent" });
    }
    return rows;
  }, [completedLayout.items, sections, showFinishedToggle]);

  // The activity key gains a `recent:` prefix once an unread finish is marked
  // read. Follow that row before paint so the highlight and j/k stay on it.
  const activeSelection = selectionFor(selectedKey, selectable);
  if (activeSelection !== selectedKey) setSelectedKey(activeSelection);

  useEffect(() => {
    if (!activeSelection) return;
    const row = scrollRef.current?.querySelector(
      `[data-activity-key="${CSS.escape(activeSelection)}"]`,
    );
    if (
      row instanceof HTMLElement &&
      typeof row.scrollIntoView === "function"
    ) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [recentExpanded, activeSelection]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (preview || event.defaultPrevented || isTypingTarget(event.target))
        return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const step = (delta: number) => {
        event.preventDefault();
        if (selectable.length === 0) return;
        const index = selectable.findIndex((row) => row.key === selectedKey);
        const next =
          index === -1
            ? delta > 0
              ? 0
              : selectable.length - 1
            : Math.min(Math.max(index + delta, 0), selectable.length - 1);
        setSelectedKey(selectable[next]?.key ?? null);
      };

      const openSelected = () => {
        if (isActivatableTarget(event.target)) return;
        const row =
          selectable.find((entry) => entry.key === selectedKey) ??
          (!selectedKey ? selectable[0] : undefined);
        if (row?.action === "toggle-recent") {
          event.preventDefault();
          setRecentExpanded((current) => !current);
          return;
        }
        const target = row?.entry ?? row?.recent;
        if (!target) return;
        event.preventDefault();
        if (row) setSelectedKey(row.key);
        activateThread(target.workspaceId, target.thread.id);
      };

      const markSelectedRead = () => {
        const row = selectable.find((entry) => entry.key === selectedKey);
        if (!row?.entry) return;
        if (row.entry.section !== "failed" && row.entry.section !== "ready") {
          return;
        }
        event.preventDefault();
        void Promise.resolve(
          onMarkThreadRead(row.entry.workspaceId, row.entry.thread.id),
        ).catch(() => {});
      };

      switch (event.key) {
        case "ArrowUp":
        case "k":
        case "K":
          return step(-1);
        case "ArrowDown":
        case "j":
        case "J":
          return step(1);
        case "Enter":
        case " ":
          return openSelected();
        case "r":
        case "R":
          return markSelectedRead();
        case "t":
        case "T":
          if (!showFinishedToggle) return;
          event.preventDefault();
          return setRecentExpanded((current) => !current);
        case "?":
          event.preventDefault();
          return setShowKeys((current) => !current);
        case "Escape":
          event.preventDefault();
          if (showKeys) return setShowKeys(false);
          if (selectedKey) return setSelectedKey(null);
          return (onReturnFocus ?? onClose)?.();
        default:
          return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    preview,
    activateThread,
    onClose,
    onMarkThreadRead,
    onOpenThread,
    onReturnFocus,
    selectable,
    showFinishedToggle,
    selectedKey,
    showKeys,
  ]);

  const subtitle =
    windowFocused === false
      ? "Click to focus"
      : attentionCount > 0
        ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`
        : runningCount > 0
          ? `${runningCount} working`
          : null;
  const isEmpty = visibleEntries.length === 0 && recentEntries.length === 0;

  return (
    <MainView
      className="relative"
      icon={<Activity aria-hidden="true" className="h-4 w-4" />}
      title="Activity"
      meta={subtitle}
      headerAriaLabel="Activity summary"
      trafficLightInset={trafficLightInset}
      onClose={onClose}
      closeLabel="Close Activity"
      actions={
        onNewThread || headerActions || onPopOut ? (
          <>
            {onNewThread ? (
              <Button type="button" onClick={onNewThread}>
                <Plus aria-hidden="true" className="h-4 w-4" />
                New task
              </Button>
            ) : null}
            {headerActions}
            {onPopOut ? (
              <Button
                type="button"
                variant="ghost"
                className="text-fg-muted"
                title="Keep Activity open in its own window"
                onClick={onPopOut}
              >
                <PanelsTopLeft aria-hidden="true" className="h-4 w-4" />
                Open in new window
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <MainViewBody
        ref={scrollRef}
        data-activity-root=""
        onPointerEnter={() => setListHovered(true)}
        onPointerLeave={() => setListHovered(false)}
      >
        {!isEmpty && onLoadPreview && onSendPreview ? (
          <p className="mb-4 px-2.5 text-xs text-fg-muted">
            Select a task and press Enter to preview, or double-click. Escape returns here.
          </p>
        ) : null}
        {isEmpty ? (
          <EmptyState
            title="All caught up"
            description="Tasks that need a response, failed, or are still working will show up here."
            className="py-16"
          />
        ) : (
          <div className="space-y-8">
            {SECTION_ORDER.map((section) => {
              const sectionEntries = sections.get(section) ?? [];
              if (sectionEntries.length === 0) return null;
              const meta = SECTION_META[section];
              return (
                <MainViewSection
                  key={section}
                  title={meta.title}
                  count={sectionEntries.length}
                  data-activity-list={section}
                >
                  {sectionEntries.map((entry) => (
                    <ActivityRow
                      key={entryKey(entry)}
                      entry={entry}
                      host={workspaceHosts[entry.workspaceId]}
                      nowMs={nowMs}
                      selected={activeSelection === entryKey(entry)}
                      resolvedRequest={resolvedRequestForEntry(
                        entry,
                        resolvedEntries[entryKey(entry)],
                      )}
                      onOpenThread={selectThread}
                      onActivateThread={
                        onLoadPreview && onSendPreview
                          ? activateThread
                          : undefined
                      }
                      onMarkThreadRead={onMarkThreadRead}
                      onRespond={handleRespond}
                    />
                  ))}
                </MainViewSection>
              );
            })}

            {completedLayout.items.length > 0 ? (
              <MainViewSection
                title="Completed"
                count={completedCount}
                data-activity-list="completed"
              >
                <div id="activity-recent-list">
                  {completedLayout.items.map((item) => (
                    <CompletedTask
                      key={item.threadKey}
                      item={item}
                      host={workspaceHosts[item.entry.workspaceId]}
                      nowMs={nowMs}
                      selected={activeSelection === completedActivityKey(item)}
                      onOpen={selectThread}
                      onActivate={
                        onLoadPreview && onSendPreview
                          ? activateThread
                          : undefined
                      }
                      onMarkRead={onMarkThreadRead}
                    />
                  ))}
                </div>
                {showFinishedToggle ? (
                  <div className="px-2.5 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-activity-key={RECENT_TOGGLE_KEY}
                      data-selected={
                        activeSelection === RECENT_TOGGLE_KEY
                          ? "true"
                          : undefined
                      }
                      aria-expanded={recentExpanded}
                      aria-controls="activity-recent-list"
                      className={cn(
                        "text-fg-muted",
                        activeSelection === RECENT_TOGGLE_KEY &&
                          "fd-row-selected text-fg-primary",
                      )}
                      onClick={() =>
                        setRecentExpanded((current) => !current)
                      }
                    >
                      {recentExpanded
                        ? "Show fewer"
                        : `Show ${hiddenFinished} more`}
                    </Button>
                  </div>
                ) : null}
              </MainViewSection>
            ) : null}
          </div>
        )}
      </MainViewBody>

      {preview && onLoadPreview && onSendPreview ? (
        <ActivityPreview
          key={`${preview.workspaceId}:${preview.threadId}`}
          {...preview}
          offline={workspaceHosts[preview.workspaceId]?.connected === false}
          draft={
            previewDrafts[`${preview.workspaceId}:${preview.threadId}`] ?? ""
          }
          onDraftChange={(value, submitted) => {
            const key = `${preview.workspaceId}:${preview.threadId}`;
            setPreviewDrafts((current) =>
              submitted !== undefined && current[key] !== submitted
                ? current
                : { ...current, [key]: value },
            );
          }}
          onLoadPreview={onLoadPreview}
          onSendPreview={onSendPreview}
          onRead={(sequence) =>
            onMarkThreadRead(preview.workspaceId, preview.threadId, sequence)
          }
          onClose={() => setPreview(null)}
          onOpen={() => {
            setPreview(null);
            onOpenThread(preview.workspaceId, preview.threadId);
          }}
        />
      ) : null}
      {showKeys ? (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="absolute inset-0 z-[2] flex items-center justify-center bg-[color:var(--fd-overlay)] p-8"
          onClick={() => setShowKeys(false)}
        >
          <div className="w-full max-w-sm rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 p-4 shadow-[var(--fd-shadow-lg)]">
            <p className="mb-3 font-medium text-fg-primary">Keyboard</p>
            <dl className="space-y-2">
              {KEY_HINTS.filter(
                (hint) => hint.key !== "esc" || onReturnFocus || onClose,
              ).map((hint) => (
                <div
                  key={hint.key}
                  className="flex items-center justify-between gap-4"
                >
                  <dt className="fd-type-supporting text-fg-secondary">
                    {hint.key === "esc" && onReturnFocus
                      ? "Back to the main app"
                      : hint.description}
                  </dt>
                  <dd className="flex shrink-0 items-center gap-1.5">
                    <Kbd>{hint.key}</Kbd>
                    {hint.alt ? (
                      <>
                        <span className="fd-type-meta text-fg-muted">or</span>
                        <Kbd>{hint.alt}</Kbd>
                      </>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
    </MainView>
  );
});
