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

import { InteractiveRequestCard } from "./interactive-request-card";

const RELATIVE_TIME_TICK_MS = 60_000;
const RESOLVED_HOLD_MS = 1_500;
const RECENT_PREVIEW_LIMIT = 5;
const RECENT_TOGGLE_KEY = "recent:toggle";
const SECTION_ORDER: readonly ActivitySection[] = [
  "blocked",
  "failed",
  "ready",
  "running",
];

export type ActivityViewProps = {
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
  running: { title: "Running" },
};

const KEY_HINTS: readonly {
  key: string;
  alt?: string;
  description: string;
}[] = [
  { key: "↑ ↓", alt: "J / K", description: "Move through the list" },
  { key: "↵", description: "Open the selected task" },
  { key: "R", description: "Mark the selected task read" },
  { key: "T", description: "Show more recent tasks" },
  { key: "?", description: "Show keyboard shortcuts" },
  { key: "esc", description: "Clear the selection" },
];

function entryKey(entry: ActivityEntry) {
  return `${entry.workspaceId}:${entry.thread.id}`;
}

function recentKey(entry: RecentEntry) {
  return `recent:${entry.workspaceId}:${entry.thread.id}`;
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
    entries
      .filter((entry) => entry.section === "blocked")
      .map(entryKey),
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

function reconcileStableKeys(
  previousKeys: string[],
  entries: ActivityEntry[],
) {
  const desiredKeys = entries.map(entryKey);
  const currentKeys = new Set(desiredKeys);
  const order = previousKeys.filter((key) => currentKeys.has(key));
  const placed = new Set(order);

  for (let desiredIndex = 0; desiredIndex < desiredKeys.length; desiredIndex += 1) {
    const key = desiredKeys[desiredIndex];
    if (!key || placed.has(key)) continue;

    let insertionIndex = -1;
    for (let index = desiredIndex - 1; index >= 0; index -= 1) {
      const precedingKey = desiredKeys[index];
      if (precedingKey && placed.has(precedingKey)) {
        insertionIndex = order.indexOf(precedingKey) + 1;
        break;
      }
    }
    if (insertionIndex === -1) {
      for (let index = desiredIndex + 1; index < desiredKeys.length; index += 1) {
        const followingKey = desiredKeys[index];
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

function useStableOrder(entries: ActivityEntry[]) {
  const orderRef = useRef(new Map<string, string[]>());
  const bySection = new Map<ActivitySection, ActivityEntry[]>();
  for (const entry of entries) {
    const sectionEntries = bySection.get(entry.section) ?? [];
    sectionEntries.push(entry);
    bySection.set(entry.section, sectionEntries);
  }

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
    entry.thread.last_tool ??
    entry.thread.last_message_preview ??
    "Working…"
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
  selected: boolean;
  onOpen: () => void;
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
  selected,
  onOpen,
  onMarkRead,
  children,
}: InboxRowProps) {
  const offline = host?.connected === false;
  const hostLabel = host
    ? `${host.name}${offline ? " · Offline" : ""}`
    : null;

  return (
    <article
      className={cn(
        "group rounded-[var(--fd-radius-md)] transition-colors duration-[var(--fd-duration-hover)]",
        selected
          ? "fd-row-selected"
          : "hover:bg-interactive-hover",
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
          className="fd-focus-inset min-w-0 flex-1 text-left"
        >
          <span className="flex items-baseline gap-3">
            <span
              className={cn(
                "fd-type-supporting min-w-0 flex-1 truncate",
                selected ? "text-fg-primary" : "text-fg-secondary group-hover:text-fg-primary",
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
    onMarkThreadRead,
    onRespond,
  }: ActivityRowProps) {
    const offline = host?.connected === false;
    const request = resolvedRequest ?? entry.requests[0];
    const canMarkRead =
      entry.section === "failed" || entry.section === "ready";

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
              <p className="fd-type-supporting text-warning">Loading request…</p>
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
    previous.onOpenThread === next.onOpenThread &&
    previous.onMarkThreadRead === next.onMarkThreadRead &&
    previous.onRespond === next.onRespond,
);

type RecentTrailProps = {
  entries: RecentEntry[];
  expanded: boolean;
  nowMs: number;
  selectedKey: string | null;
  onToggle: () => void;
  onOpenThread: ActivityViewProps["onOpenThread"];
};

const RecentTrail = memo(function RecentTrail({
  entries,
  expanded,
  nowMs,
  selectedKey,
  onToggle,
  onOpenThread,
}: RecentTrailProps) {
  if (entries.length === 0) return null;
  const visibleEntries = expanded
    ? entries
    : entries.slice(0, RECENT_PREVIEW_LIMIT);
  const hiddenCount = entries.length - visibleEntries.length;

  return (
    <section aria-labelledby="activity-recent">
      <div className="mb-1.5 flex items-baseline gap-2 px-2.5">
        <h2 id="activity-recent" className="fd-type-eyebrow text-fg-muted">
          Recent
        </h2>
        <span className="fd-type-meta text-fg-muted">{entries.length}</span>
      </div>
      <div id="activity-recent-list">
        {visibleEntries.map((entry) => {
          const key = recentKey(entry);
          return (
            <InboxRow
              key={key}
              activityKey={key}
              title={entry.thread.title}
              preview={entry.thread.last_message_preview}
              projectLabel={entry.projectLabel}
              timeLabel={timeAgo(entry.thread.updated_at, nowMs)}
              selected={selectedKey === key}
              onOpen={() => onOpenThread(entry.workspaceId, entry.thread.id)}
            />
          );
        })}
      </div>
      {entries.length > RECENT_PREVIEW_LIMIT ? (
        <div className="px-2.5 pt-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-activity-key={RECENT_TOGGLE_KEY}
            data-selected={
              selectedKey === RECENT_TOGGLE_KEY ? "true" : undefined
            }
            aria-expanded={expanded}
            aria-controls="activity-recent-list"
            className={cn(
              "text-fg-muted",
              selectedKey === RECENT_TOGGLE_KEY && "fd-row-selected text-fg-primary",
            )}
            onClick={onToggle}
          >
            {expanded ? "Show fewer" : `Show ${hiddenCount} more`}
          </Button>
        </div>
      ) : null}
    </section>
  );
});

export const ActivityView = memo(function ActivityView({
  groups,
  interactiveRequests,
  workspaceHosts = {},
  onOpenThread,
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
  const [nowMs, setNowMs] = useState(Date.now);
  const [recentExpanded, setRecentExpanded] = useState(false);
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

  const recentEntries = useMemo(
    () => collectRecentEntries(groups, interactiveRequests, { nowMs }),
    [groups, interactiveRequests, nowMs],
  );
  const visibleRecentEntries = useMemo(
    () =>
      recentExpanded
        ? recentEntries
        : recentEntries.slice(0, RECENT_PREVIEW_LIMIT),
    [recentEntries, recentExpanded],
  );

  const selectable = useMemo(() => {
    const rows: {
      key: string;
      section?: ActivitySection;
      entry?: ActivityEntry;
      recent?: RecentEntry;
      action?: "toggle-recent";
    }[] = [];
    for (const section of SECTION_ORDER) {
      for (const entry of sections.get(section) ?? []) {
        rows.push({ key: entryKey(entry), section, entry });
      }
    }
    for (const recent of visibleRecentEntries) {
      rows.push({ key: recentKey(recent), recent });
    }
    if (recentEntries.length > RECENT_PREVIEW_LIMIT) {
      rows.push({ key: RECENT_TOGGLE_KEY, action: "toggle-recent" });
    }
    return rows;
  }, [recentEntries.length, sections, visibleRecentEntries]);

  useEffect(() => {
    if (selectedKey && !selectable.some((row) => row.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [selectable, selectedKey]);

  useEffect(() => {
    if (!selectedKey) return;
    const row = scrollRef.current?.querySelector(
      `[data-activity-key="${CSS.escape(selectedKey)}"]`,
    );
    if (row instanceof HTMLElement && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [recentExpanded, selectedKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
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
        onOpenThread(target.workspaceId, target.thread.id);
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
          if (recentEntries.length <= RECENT_PREVIEW_LIMIT) return;
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
    onClose,
    onMarkThreadRead,
    onOpenThread,
    onReturnFocus,
    recentEntries.length,
    selectable,
    selectedKey,
    showKeys,
  ]);

  const subtitle =
    windowFocused === false
      ? "Click to focus"
      : attentionCount > 0
        ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`
        : runningCount > 0
          ? `${runningCount} running`
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
      <MainViewBody ref={scrollRef}>
        {isEmpty ? (
          <EmptyState
            title="All caught up"
            description="Tasks that need a response, failed, or are still running will show up here."
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
                      selected={selectedKey === entryKey(entry)}
                      resolvedRequest={resolvedRequestForEntry(
                        entry,
                        resolvedEntries[entryKey(entry)],
                      )}
                      onOpenThread={onOpenThread}
                      onMarkThreadRead={onMarkThreadRead}
                      onRespond={handleRespond}
                    />
                  ))}
                </MainViewSection>
              );
            })}

            <RecentTrail
              entries={recentEntries}
              expanded={recentExpanded}
              nowMs={nowMs}
              selectedKey={selectedKey}
              onToggle={() => setRecentExpanded((current) => !current)}
              onOpenThread={onOpenThread}
            />
          </div>
        )}
      </MainViewBody>

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
