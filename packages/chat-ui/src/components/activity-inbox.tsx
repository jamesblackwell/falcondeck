import * as React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowLeft, PanelsTopLeft } from "lucide-react";

import {
  collectActivityInbox,
  type ActivityInboxRow,
  type InteractiveRequest,
  type ProjectGroup,
  type ThreadSummary,
} from "@falcondeck/client-core";
import { ActivityDiamond, Tooltip, cn } from "@falcondeck/ui";

/* ================================================================
   Activity inbox — the sidebar's mail view.

   One dense, hairline-divided list across every project. Selecting a row
   opens the task in the main pane, which acts as the reading pane, so the
   inbox never takes over the window. Tasks that need a response or failed
   are pinned above a newest-first feed grouped by day.
   ================================================================ */

export type ActivityInboxFilter = "all" | "unread" | "running";

const FILTERS: readonly { id: ActivityInboxFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "running", label: "Running" },
];

const FEED_PAGE = 60;

export type ActivityInboxProps = {
  groups: ProjectGroup[];
  interactiveRequests: InteractiveRequest[];
  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;
  workspaceHosts?: Record<string, { name: string; connected: boolean }>;
  nowTick: number;
  /** Opens the task in the reading pane without moving keyboard focus. */
  onPreviewThread: (workspaceId: string, threadId: string) => void;
  /** Opens the task and hands focus to its composer. */
  onOpenThread: (workspaceId: string, threadId: string) => void;
  onArchiveThread?: (
    workspaceId: string,
    threadId: string,
  ) => Promise<void> | void;
  onOpenContextMenu?: (args: {
    workspaceId: string;
    thread: ThreadSummary;
    x: number;
    y: number;
  }) => void;
  onClose: () => void;
  onPopOut?: () => void;
};

type Bucket = "needs" | "feed";

function timeLabel(dateStr: string, nowMs: number) {
  const date = new Date(dateStr);
  const seconds = Math.max(0, Math.floor((nowMs - date.getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  // Older rows sit under a day heading, so the clock time is the useful part.
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function startOfDay(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayLabel(dateStr: string, nowMs: number) {
  const date = new Date(dateStr);
  const days = Math.round(
    (startOfDay(nowMs) - startOfDay(date.getTime())) / 86_400_000,
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
  }).format(date);
}

function requestSummary(request: InteractiveRequest | undefined) {
  if (!request) return "Waiting for your response";
  const label = request.kind === "question" ? "Question" : "Approval";
  return `${label}: ${request.command ?? request.title}`;
}

function rowPreview(row: ActivityInboxRow) {
  if (row.section === "blocked") return requestSummary(row.requests[0]);
  if (row.section === "failed") return row.thread.last_error ?? "The run failed";
  if (row.section === "running") {
    return row.thread.last_tool ?? row.thread.last_message_preview ?? "Working…";
  }
  return row.thread.last_message_preview ?? "";
}

function matchesFilter(row: ActivityInboxRow, filter: ActivityInboxFilter) {
  if (filter === "unread") return row.unread;
  if (filter === "running") return row.section === "running";
  return true;
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

function StatusMark({ row }: { row: ActivityInboxRow }) {
  if (row.section === "running") return <ActivityDiamond size="xs" />;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-1.5 w-1.5 rounded-full",
        row.section === "blocked" && "bg-warning",
        row.section === "failed" && "bg-danger",
        row.section === "ready" && "bg-unread",
      )}
    />
  );
}

type InboxRowProps = {
  row: ActivityInboxRow;
  selected: boolean;
  nowMs: number;
  host?: { name: string; connected: boolean };
  onSelect: (row: ActivityInboxRow) => void;
  onOpen: (row: ActivityInboxRow) => void;
  onArchive?: (row: ActivityInboxRow) => void;
  onOpenContextMenu?: ActivityInboxProps["onOpenContextMenu"];
};

const InboxRow = memo(function InboxRow({
  row,
  selected,
  nowMs,
  host,
  onSelect,
  onOpen,
  onArchive,
  onOpenContextMenu,
}: InboxRowProps) {
  const offline = host?.connected === false;
  const preview = rowPreview(row);
  const emphasised = row.unread || row.section === "blocked";

  return (
    <div
      role="option"
      aria-selected={selected}
      data-inbox-key={row.key}
      className={cn(
        "group relative flex cursor-default gap-2 border-b border-border-subtle py-2 pl-2.5 pr-3",
        "transition-colors duration-[var(--fd-duration-hover)]",
        selected
          ? "fd-row-selected"
          : "hover:bg-interactive-hover active:bg-interactive-selected",
        offline && "opacity-60",
      )}
      onClick={() => onSelect(row)}
      onDoubleClick={() => onOpen(row)}
      onContextMenu={(event) => {
        if (!onOpenContextMenu) return;
        event.preventDefault();
        onOpenContextMenu({
          workspaceId: row.workspaceId,
          thread: row.thread,
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      <span className="flex h-[1lh] w-3 shrink-0 items-center justify-center text-[length:var(--fd-text-sm)]">
        <StatusMark row={row} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)]",
              emphasised
                ? "font-semibold text-fg-primary"
                : "text-fg-secondary",
            )}
          >
            {row.thread.title}
          </span>
          <span
            className={cn(
              "shrink-0 text-[length:var(--fd-text-2xs)] tabular-nums",
              row.unread ? "text-fg-secondary" : "text-fg-muted",
              onArchive &&
                "group-hover:invisible group-focus-within:invisible",
            )}
          >
            {timeLabel(row.thread.updated_at, nowMs)}
          </span>
        </span>
        <span className="mt-0.5 flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)]",
              row.section === "failed"
                ? "text-danger"
                : row.section === "blocked"
                  ? "text-warning"
                  : "text-fg-muted",
            )}
            title={preview || undefined}
          >
            {preview || " "}
          </span>
          <span className="max-w-[45%] shrink-0 truncate text-[length:var(--fd-text-2xs)] text-fg-muted">
            {host ? `${row.projectLabel} · ${host.name}` : row.projectLabel}
          </span>
        </span>
      </span>
      {onArchive ? (
        <Tooltip label="Archive" shortcut={["E"]}>
          <button
            type="button"
            aria-label={`Archive ${row.thread.title}`}
            tabIndex={-1}
            className="fd-focus absolute right-2 top-1.5 flex h-6 w-6 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted opacity-0 transition-opacity hover:bg-surface-4 hover:text-fg-primary focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onArchive(row);
            }}
          >
            <Archive aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
});

function GroupHeading({
  label,
  count,
  tone,
}: {
  label: string;
  count?: number;
  tone?: "warning";
}) {
  return (
    <div
      role="presentation"
      className="sticky top-0 z-[1] flex items-baseline gap-2 border-b border-border-subtle bg-surface-1 px-3 pb-1 pt-3"
    >
      <span
        className={cn(
          "text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em]",
          tone === "warning" ? "text-warning" : "text-fg-muted",
        )}
      >
        {label}
      </span>
      {count !== undefined ? (
        <span className="text-[length:var(--fd-text-2xs)] tabular-nums text-fg-muted">
          {count}
        </span>
      ) : null}
    </div>
  );
}

export const ActivityInbox = memo(function ActivityInbox({
  groups,
  interactiveRequests,
  selectedWorkspaceId,
  selectedThreadId,
  workspaceHosts = {},
  nowTick,
  onPreviewThread,
  onOpenThread,
  onArchiveThread,
  onOpenContextMenu,
  onClose,
  onPopOut,
}: ActivityInboxProps) {
  const [filter, setFilter] = useState<ActivityInboxFilter>("all");
  const [feedLimit, setFeedLimit] = useState(FEED_PAGE);
  const listRef = useRef<HTMLDivElement>(null);
  // nowTick advances once a minute; the clock only needs that resolution.
  const nowMs = useMemo(() => Date.now(), [nowTick]);
  const inbox = useMemo(
    () => collectActivityInbox(groups, interactiveRequests, { nowMs }),
    [groups, interactiveRequests, nowMs],
  );

  const selectedKey =
    selectedWorkspaceId && selectedThreadId
      ? `${selectedWorkspaceId}:${selectedThreadId}`
      : null;

  // The open row stays where it was when you opened it. Reading a failed
  // task or answering a question would otherwise move it out of Needs you,
  // and the Unread filter would drop it, right under the pointer.
  const heldRef = useRef<{ key: string; row: ActivityInboxRow; bucket: Bucket } | null>(null);
  const liveBucket = (key: string | null): Bucket | null => {
    if (!key) return null;
    if (inbox.needsYou.some((row) => row.key === key)) return "needs";
    if (inbox.feed.some((row) => row.key === key)) return "feed";
    return null;
  };
  if (heldRef.current?.key !== selectedKey) {
    const bucket = liveBucket(selectedKey);
    const row =
      bucket === "needs"
        ? inbox.needsYou.find((candidate) => candidate.key === selectedKey)
        : inbox.feed.find((candidate) => candidate.key === selectedKey);
    heldRef.current =
      selectedKey && bucket && row ? { key: selectedKey, row, bucket } : null;
  }
  const held = heldRef.current;

  const { needsYou, feed, hiddenCount } = useMemo(() => {
    const currentHeld =
      held &&
      (inbox.needsYou.find((row) => row.key === held.key) ??
        inbox.feed.find((row) => row.key === held.key));
    const heldRow = held ? (currentHeld ?? null) : null;
    const place = (rows: ActivityInboxRow[], bucket: Bucket) => {
      const result = rows.filter(
        (row) =>
          row.key !== held?.key && (bucket === "needs" || matchesFilter(row, filter)),
      );
      if (held && heldRow && held.bucket === bucket) {
        const index = rows.findIndex((row) => row.key === held.key);
        const insertAt =
          index === -1
            ? bucket === "needs"
              ? result.length
              : result.findIndex(
                  (row) => row.thread.updated_at < heldRow.thread.updated_at,
                )
            : result.filter((row) => rows.indexOf(row) < index).length;
        result.splice(insertAt === -1 ? result.length : insertAt, 0, heldRow);
      }
      return result;
    };
    const filteredFeed = place(inbox.feed, "feed");
    return {
      needsYou: filter === "running" ? [] : place(inbox.needsYou, "needs"),
      feed: filteredFeed.slice(0, feedLimit),
      hiddenCount: Math.max(0, filteredFeed.length - feedLimit),
    };
  }, [feedLimit, filter, held, inbox]);

  const orderedRows = useMemo(() => [...needsYou, ...feed], [needsYou, feed]);
  const unreadCount = useMemo(
    () =>
      inbox.needsYou.length + inbox.feed.filter((row) => row.unread).length,
    [inbox],
  );
  const runningCount = useMemo(
    () => inbox.feed.filter((row) => row.section === "running").length,
    [inbox],
  );

  const selectRow = useCallback(
    (row: ActivityInboxRow) => onPreviewThread(row.workspaceId, row.thread.id),
    [onPreviewThread],
  );
  const openRow = useCallback(
    (row: ActivityInboxRow) => onOpenThread(row.workspaceId, row.thread.id),
    [onOpenThread],
  );

  const orderedRowsRef = useRef(orderedRows);
  orderedRowsRef.current = orderedRows;
  const archiveRow = useCallback(
    (row: ActivityInboxRow) => {
      if (!onArchiveThread) return;
      // Like mail: archiving the open task moves the reading pane on to the
      // next one instead of leaving it blank.
      const rows = orderedRowsRef.current;
      const index = rows.findIndex((candidate) => candidate.key === row.key);
      const next =
        row.key === selectedKey
          ? (rows[index + 1] ?? rows[index - 1] ?? null)
          : null;
      void Promise.resolve(
        onArchiveThread(row.workspaceId, row.thread.id),
      ).then(
        () => {
          if (next) onPreviewThread(next.workspaceId, next.thread.id);
        },
        () => {},
      );
    },
    [onArchiveThread, onPreviewThread, selectedKey],
  );

  useEffect(() => {
    if (!selectedKey) return;
    const node = listRef.current?.querySelector(
      `[data-inbox-key="${CSS.escape(selectedKey)}"]`,
    );
    if (node instanceof HTMLElement && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [selectedKey]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isTypingTarget(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const index = orderedRows.findIndex((row) => row.key === selectedKey);
    const step = (delta: number) => {
      event.preventDefault();
      if (orderedRows.length === 0) return;
      const nextIndex =
        index === -1
          ? delta > 0
            ? 0
            : orderedRows.length - 1
          : Math.min(Math.max(index + delta, 0), orderedRows.length - 1);
      const next = orderedRows[nextIndex];
      if (next && next.key !== selectedKey) selectRow(next);
    };
    const current = index === -1 ? null : orderedRows[index];
    switch (event.key) {
      case "ArrowDown":
      case "j":
        return step(1);
      case "ArrowUp":
      case "k":
        return step(-1);
      case "Enter":
        if (!current) return;
        event.preventDefault();
        return openRow(current);
      case "e":
      case "E":
        if (!current || !onArchiveThread) return;
        event.preventDefault();
        return archiveRow(current);
      case "Escape":
        event.preventDefault();
        return onClose();
      default:
        return;
    }
  };

  const feedGroups = useMemo(() => {
    const result: { label: string; rows: ActivityInboxRow[] }[] = [];
    for (const row of feed) {
      const label = dayLabel(row.thread.updated_at, nowMs);
      const last = result[result.length - 1];
      if (last?.label === label) last.rows.push(row);
      else result.push({ label, rows: [row] });
    }
    return result;
  }, [feed, nowMs]);

  const renderRow = (row: ActivityInboxRow) => (
    <InboxRow
      key={row.key}
      row={row}
      selected={row.key === selectedKey}
      nowMs={nowMs}
      host={workspaceHosts[row.workspaceId]}
      onSelect={selectRow}
      onOpen={openRow}
      onArchive={onArchiveThread ? archiveRow : undefined}
      onOpenContextMenu={onOpenContextMenu}
    />
  );

  const isEmpty = needsYou.length === 0 && feed.length === 0;

  return (
    <section aria-label="Activity" className="-mx-3 flex min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2.5 pb-2">
        <Tooltip label="Back to projects" shortcut={["esc"]}>
          <button
            type="button"
            onClick={onClose}
            aria-label="Back to projects"
            className="fd-focus flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--fd-radius-md)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-primary"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          </button>
        </Tooltip>
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">
          Activity
        </h2>
        {onPopOut ? (
          <Tooltip label="Open in a new window">
            <button
              type="button"
              onClick={onPopOut}
              aria-label="Open Activity in a new window"
              className="fd-focus flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--fd-radius-md)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-primary"
            >
              <PanelsTopLeft aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <div
        role="radiogroup"
        aria-label="Filter activity"
        className="mx-3 mb-1 flex gap-0.5 rounded-[var(--fd-radius-md)] bg-surface-2 p-0.5"
      >
        {FILTERS.map((option) => {
          const count =
            option.id === "unread"
              ? unreadCount
              : option.id === "running"
                ? runningCount
                : null;
          const active = filter === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setFilter(option.id);
                setFeedLimit(FEED_PAGE);
              }}
              className={cn(
                "fd-focus flex flex-1 items-center justify-center gap-1 rounded-[var(--fd-radius-sm)] px-2 py-1 text-[length:var(--fd-text-xs)] transition-colors",
                active
                  ? "bg-surface-1 font-medium text-fg-primary shadow-[var(--fd-shadow-sm)]"
                  : "text-fg-muted hover:text-fg-secondary",
              )}
            >
              {option.label}
              {count ? (
                <span className="tabular-nums text-fg-muted">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Activity"
        tabIndex={0}
        data-activity-inbox=""
        onKeyDown={handleKeyDown}
        className="fd-focus-inset outline-none"
      >
        {isEmpty ? (
          <p className="px-4 py-10 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            {filter === "unread"
              ? "Nothing unread."
              : filter === "running"
                ? "Nothing running."
                : "No task activity this week."}
          </p>
        ) : null}
        {needsYou.length > 0 ? (
          <div role="group" aria-label="Needs you">
            <GroupHeading label="Needs you" count={needsYou.length} tone="warning" />
            {needsYou.map(renderRow)}
          </div>
        ) : null}
        {feedGroups.map((group) => (
          <div key={group.label} role="group" aria-label={group.label}>
            <GroupHeading label={group.label} />
            {group.rows.map(renderRow)}
          </div>
        ))}
        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setFeedLimit((current) => current + FEED_PAGE)}
            className="fd-focus w-full px-3 py-2 text-left text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-interactive-hover hover:text-fg-secondary"
          >
            Show {Math.min(hiddenCount, FEED_PAGE)} more
          </button>
        ) : null}
      </div>
    </section>
  );
});
