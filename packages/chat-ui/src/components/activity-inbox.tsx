import * as React from "react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Archive, ArrowLeft, PanelsTopLeft, SquarePen } from "lucide-react";

import {
  collectActivityInbox,
  projectLabel,
  type ActivityInbox as ActivityInboxModel,
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

   Rows hold still. A task only moves up when an agent finishes new work
   while it is not open, and nothing reflows while the pointer is over the
   list; whatever changed underneath settles once it leaves.
   ================================================================ */

export type ActivityInboxFilter = "all" | "unread" | "running";

const FILTERS: readonly { id: ActivityInboxFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "running", label: "Running" },
];

const FEED_PAGE = 60;
/**
 * How long after the open task is cleared we still treat its archive as
 * "move on to the next one". Long enough for a snapshot round trip.
 */
const ADVANCE_WINDOW_MS = 5_000;

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
  /** Starts a new task; shown in the inbox header beside the title. */
  onNewChat?: () => void;
  newChatLabel?: string;
  newChatShortcut?: string[];
};

type Bucket = "needs" | "feed";

/** The open row, pinned to the bucket and slot it had when it was opened. */
type HeldRow = { key: string; bucket: Bucket; index: number };

/** The open row and its neighbour, for moving on once it is archived. */
type PendingAdvance = {
  key: string;
  next: ActivityInboxRow | null;
  clearedAt: number | null;
};

/** Where a feed row sorts, and what it looked like when it got there. */
type FeedSlot = { at: string; seq: number; running: boolean };

/** The rows on screen, by key, held while the pointer is over the list. */
type FrozenLayout = {
  filter: ActivityInboxFilter;
  feedLimit: number;
  needsYou: string[];
  feed: string[];
  /** Feed times as shown, so day headings cannot split while held. */
  orderAt: ReadonlyMap<string, string>;
};

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

/**
 * One readable line from a message preview: no scheduler envelope, no
 * markdown punctuation, no line breaks.
 */
function plainPreview(text: string | null | undefined) {
  if (!text) return "";
  return text
    .replace(/<falcondeck_automation>[\s\S]*?(?:<\/falcondeck_automation>|$)/g, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rowPreview(row: ActivityInboxRow) {
  if (row.section === "blocked") return requestSummary(row.requests[0]);
  if (row.section === "failed") return row.thread.last_error ?? "The run failed";
  if (row.section === "running") {
    return (
      row.thread.last_tool ??
      (plainPreview(row.thread.last_message_preview) || "Working…")
    );
  }
  return plainPreview(row.thread.last_message_preview);
}

function matchesFilter(
  row: ActivityInboxRow,
  bucket: Bucket,
  filter: ActivityInboxFilter,
) {
  // Needs you is always unread work, and never "running" from the user's
  // point of view: it is waiting on them.
  if (filter === "running") return bucket === "feed" && row.section === "running";
  if (filter === "unread") return bucket === "needs" || row.unread;
  return true;
}

function holdFor(key: string | null, inbox: ActivityInboxModel): HeldRow | null {
  if (!key) return null;
  for (const bucket of ["needs", "feed"] as const) {
    const rows = bucket === "needs" ? inbox.needsYou : inbox.feed;
    const index = rows.findIndex((row) => row.key === key);
    if (index !== -1) return { key, bucket, index };
  }
  return null;
}

/**
 * A row as it is now. A task can leave both lists while it is on screen —
 * a week-old failure that has just been read, say — so fall back to a
 * settled row for it rather than letting it vanish. Archived tasks do go.
 */
function rowForKey(
  key: string,
  inbox: ActivityInboxModel,
  groups: ProjectGroup[],
): ActivityInboxRow | null {
  const live =
    inbox.needsYou.find((row) => row.key === key) ??
    inbox.feed.find((row) => row.key === key);
  if (live) return live;
  for (const group of groups) {
    for (const thread of group.threads) {
      if (`${group.workspace.id}:${thread.id}` !== key) continue;
      if (thread.is_archived) return null;
      return {
        key,
        thread,
        workspaceId: group.workspace.id,
        projectLabel: projectLabel(group.workspace.path),
        section: null,
        unread: false,
        requests: [],
      };
    }
  }
  return null;
}

/** Filter one bucket, keeping the held row in it whatever the filter says. */
function placeRows(
  rows: ActivityInboxRow[],
  bucket: Bucket,
  filter: ActivityInboxFilter,
  held: HeldRow | null,
  heldRow: ActivityInboxRow | null,
  orderAt: ReadonlyMap<string, string>,
) {
  const result = rows.filter(
    (row) => row.key !== held?.key && matchesFilter(row, bucket, filter),
  );
  if (!held || !heldRow || held.bucket !== bucket) return result;

  const natural = rows.findIndex((row) => row.key === held.key);
  let insertAt: number;
  if (natural !== -1) {
    // Still in its own bucket: its natural slot among the visible rows.
    const before = new Set(rows.slice(0, natural).map((row) => row.key));
    insertAt = result.filter((row) => before.has(row.key)).length;
  } else if (bucket === "needs") {
    // Answered or read: keep the slot it had in Needs you.
    insertAt = Math.min(held.index, result.length);
  } else {
    // Moved up into Needs you while open: keep the feed's date order.
    const at = (row: ActivityInboxRow) =>
      orderAt.get(row.key) ?? row.thread.updated_at;
    insertAt = result.findIndex((row) => at(row) < at(heldRow));
    if (insertAt === -1) insertAt = result.length;
  }
  result.splice(insertAt, 0, heldRow);
  return result;
}

function liveThreadKeys(groups: ProjectGroup[]) {
  const keys = new Set<string>();
  for (const group of groups) {
    for (const thread of group.threads) {
      if (!thread.is_archived) keys.add(`${group.workspace.id}:${thread.id}`);
    }
  }
  return keys;
}

/**
 * Newest-first, but only for news. A row's place is fixed when it first
 * appears and moves again only when an agent finishes work the user has not
 * watched: a turn ending, or new activity on an idle task. Streaming output
 * (which bumps updated_at constantly), title changes, transcript loads, and
 * anything that happens while the task is open leave it where it is.
 */
function useStableFeedOrder(
  inbox: ActivityInboxModel,
  selectedKey: string | null,
): { inbox: ActivityInboxModel; orderAt: ReadonlyMap<string, string> } {
  const slotsRef = useRef(new Map<string, FeedSlot>());

  return useMemo(() => {
    const slots = slotsRef.current;
    for (const row of [...inbox.needsYou, ...inbox.feed]) {
      const seq = row.thread.attention.last_agent_activity_seq;
      const running = row.section === "running";
      const slot = slots.get(row.key);
      if (!slot) {
        slots.set(row.key, { at: row.thread.updated_at, seq, running });
        continue;
      }
      if (
        row.key !== selectedKey &&
        !running &&
        (slot.running || seq > slot.seq)
      ) {
        slot.at = row.thread.updated_at;
      }
      slot.seq = seq;
      slot.running = running;
    }
    const live = new Set(
      [...inbox.needsYou, ...inbox.feed].map((row) => row.key),
    );
    for (const key of slots.keys()) {
      if (!live.has(key)) slots.delete(key);
    }

    const orderAt = new Map<string, string>();
    for (const [key, slot] of slots) orderAt.set(key, slot.at);
    const at = (row: ActivityInboxRow) =>
      orderAt.get(row.key) ?? row.thread.updated_at;
    const feed = [...inbox.feed].sort(
      (left, right) =>
        (at(left) < at(right) ? 1 : at(left) > at(right) ? -1 : 0) ||
        left.key.localeCompare(right.key),
    );
    return { inbox: { needsYou: inbox.needsYou, feed }, orderAt };
  }, [inbox, selectedKey]);
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
  id: string;
  row: ActivityInboxRow;
  /** When the row landed in the inbox, which is what it sorts by. */
  at: string;
  selected: boolean;
  nowMs: number;
  host?: { name: string; connected: boolean };
  onSelect: (row: ActivityInboxRow) => void;
  onOpen: (row: ActivityInboxRow) => void;
  onArchive?: (row: ActivityInboxRow) => void;
  onOpenContextMenu?: ActivityInboxProps["onOpenContextMenu"];
};

const InboxRow = memo(function InboxRow({
  id,
  row,
  at,
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

  return (
    <div
      id={id}
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
              row.unread
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
              onArchive && "group-hover:invisible",
            )}
          >
            {timeLabel(at, nowMs)}
          </span>
        </span>
        <span
          className="mt-0.5 block truncate text-[length:var(--fd-text-xs)] text-fg-muted"
          title={preview || undefined}
        >
          <span className="text-fg-secondary">
            {host ? `${row.projectLabel} · ${host.name}` : row.projectLabel}
          </span>
          {preview ? (
            <>
              <span aria-hidden="true"> · </span>
              <span
                className={cn(
                  row.section === "failed" && "text-danger",
                  row.section === "blocked" && "text-warning",
                )}
              >
                {preview}
              </span>
            </>
          ) : null}
        </span>
      </span>
      {onArchive ? (
        <Tooltip label="Archive" shortcut={["E"]}>
          <button
            type="button"
            aria-label={`Archive ${row.thread.title}`}
            tabIndex={-1}
            // Out of the tab order: the focused list archives with E.
            className="absolute right-2 top-1.5 flex h-6 w-6 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted opacity-0 transition-opacity hover:bg-surface-4 hover:text-fg-primary group-hover:opacity-100"
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
  onNewChat,
  newChatLabel = "New chat",
  newChatShortcut,
}: ActivityInboxProps) {
  const [filter, setFilter] = useState<ActivityInboxFilter>("all");
  const [feedLimit, setFeedLimit] = useState(FEED_PAGE);
  const listRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  // nowTick advances once a minute; the clock only needs that resolution.
  const nowMs = useMemo(() => Date.now(), [nowTick]);
  const collected = useMemo(
    () => collectActivityInbox(groups, interactiveRequests, { nowMs }),
    [groups, interactiveRequests, nowMs],
  );

  const selectedKey =
    selectedWorkspaceId && selectedThreadId
      ? `${selectedWorkspaceId}:${selectedThreadId}`
      : null;
  const { inbox, orderAt } = useStableFeedOrder(collected, selectedKey);

  // The open row stays where it was when you opened it. Reading a failed
  // task or answering a question would otherwise move it out of Needs you,
  // and the Unread filter would drop it, right under the pointer.
  const [held, setHeld] = useState<HeldRow | null>(null);
  if ((held?.key ?? null) !== selectedKey) {
    const nextHeld = holdFor(selectedKey, inbox);
    if (nextHeld?.key !== held?.key) setHeld(nextHeld);
  }

  const live = useMemo(() => {
    const heldRow = held ? rowForKey(held.key, inbox, groups) : null;
    const filteredFeed = placeRows(
      inbox.feed,
      "feed",
      filter,
      held,
      heldRow,
      orderAt,
    );
    return {
      needsYou: placeRows(
        inbox.needsYou,
        "needs",
        filter,
        held,
        heldRow,
        orderAt,
      ),
      feed: filteredFeed.slice(0, feedLimit),
      hiddenCount: Math.max(0, filteredFeed.length - feedLimit),
    };
  }, [feedLimit, filter, groups, held, inbox, orderAt]);

  // While the pointer is over the list, the rows on screen stay put: a task
  // read under Unread or answered in Needs you keeps its row, and new work
  // waits. Leaving the list lets it all settle. Rows still update in place,
  // and archived ones still go.
  const [hovering, setHovering] = useState(false);
  const [frozen, setFrozen] = useState<FrozenLayout | null>(null);
  const frozenStale =
    !frozen ||
    frozen.filter !== filter ||
    frozen.feedLimit !== feedLimit ||
    // Selection from elsewhere (header archive, palette) must stay visible.
    (selectedKey !== null &&
      !frozen.needsYou.includes(selectedKey) &&
      !frozen.feed.includes(selectedKey) &&
      [...live.needsYou, ...live.feed].some((row) => row.key === selectedKey));
  useEffect(() => {
    if (!hovering || !frozenStale) return;
    setFrozen({
      filter,
      feedLimit,
      needsYou: live.needsYou.map((row) => row.key),
      feed: live.feed.map((row) => row.key),
      orderAt,
    });
  }, [feedLimit, filter, frozenStale, hovering, live, orderAt]);

  const holding = hovering && !frozenStale && frozen !== null;
  const { needsYou, feed, hiddenCount, shownAt } = useMemo(() => {
    if (!holding || !frozen) return { ...live, shownAt: orderAt };
    const rows = (keys: string[]) =>
      keys.flatMap((key) => rowForKey(key, inbox, groups) ?? []);
    return {
      needsYou: rows(frozen.needsYou),
      feed: rows(frozen.feed),
      hiddenCount: live.hiddenCount,
      shownAt: frozen.orderAt,
    };
  }, [frozen, groups, holding, inbox, live, orderAt]);
  const rowAt = useCallback(
    (row: ActivityInboxRow) => shownAt.get(row.key) ?? row.thread.updated_at,
    [shownAt],
  );

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
  const archiveRow = useCallback(
    (row: ActivityInboxRow) => {
      if (!onArchiveThread) return;
      void Promise.resolve(
        onArchiveThread(row.workspaceId, row.thread.id),
      ).catch(() => {});
    },
    [onArchiveThread],
  );

  // Like mail, archiving the open task moves the reading pane on to the next
  // visible one instead of leaving it blank — whether the archive came from
  // this list, the task header, or the context menu. The host clears the
  // selection when the open task is archived; once the task has actually
  // left the live list, select its neighbour.
  const advanceRef = useRef<PendingAdvance | null>(null);
  useEffect(() => {
    if (selectedKey) {
      const index = orderedRows.findIndex((row) => row.key === selectedKey);
      advanceRef.current =
        index === -1
          ? null
          : {
              key: selectedKey,
              next: orderedRows[index + 1] ?? orderedRows[index - 1] ?? null,
              clearedAt: null,
            };
      return;
    }
    const pending = advanceRef.current;
    if (!pending) return;
    pending.clearedAt ??= Date.now();
    if (Date.now() - pending.clearedAt > ADVANCE_WINDOW_MS) {
      advanceRef.current = null;
      return;
    }
    const live = liveThreadKeys(groups);
    // Still live: the selection went elsewhere (a new task), or the snapshot
    // with the archive has not landed yet. Wait for the next groups update.
    if (live.has(pending.key)) return;
    advanceRef.current = null;
    if (pending.next && live.has(pending.next.key)) selectRow(pending.next);
  }, [groups, orderedRows, selectRow, selectedKey]);

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
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const index = orderedRows.findIndex((row) => row.key === selectedKey);
    const current = index === -1 ? null : orderedRows[index];
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
    switch (event.key) {
      case "ArrowDown":
      case "j":
      case "J":
        return step(1);
      case "ArrowUp":
      case "k":
      case "K":
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
    const result: { key: string; label: string; rows: ActivityInboxRow[] }[] =
      [];
    const seen = new Map<string, number>();
    for (const row of feed) {
      const label = dayLabel(rowAt(row), nowMs);
      const last = result[result.length - 1];
      if (last?.label === label) {
        last.rows.push(row);
        continue;
      }
      // A held row can sit out of date order, so a label may come back.
      const repeat = seen.get(label) ?? 0;
      seen.set(label, repeat + 1);
      result.push({
        key: repeat ? `${label}:${repeat}` : label,
        label,
        rows: [row],
      });
    }
    return result;
  }, [feed, nowMs, rowAt]);

  const optionId = (row: ActivityInboxRow) => `${idPrefix}-${row.key}`;
  const renderRow = (row: ActivityInboxRow) => (
    <InboxRow
      key={row.key}
      id={optionId(row)}
      row={row}
      at={rowAt(row)}
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
      <div className="flex items-center gap-0.5 pb-1 pl-1.5 pr-2">
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
        <h2 className="min-w-0 flex-1 truncate pl-0.5 text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">
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
        {onNewChat ? (
          <Tooltip label={newChatLabel} shortcut={newChatShortcut}>
            <button
              type="button"
              onClick={onNewChat}
              aria-label={newChatLabel}
              className="fd-focus flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--fd-radius-md)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-primary"
            >
              <SquarePen aria-hidden="true" className="h-4 w-4" />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <div
        role="radiogroup"
        aria-label="Filter activity"
        className="flex items-center gap-1 px-3 pb-2"
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
                "fd-focus flex h-6 items-center gap-1 rounded-full px-2.5 text-[length:var(--fd-text-xs)] transition-colors",
                active
                  ? "bg-surface-3 font-medium text-fg-primary"
                  : "text-fg-muted hover:bg-surface-2 hover:text-fg-secondary",
              )}
            >
              {option.label}
              {count ? (
                <span
                  className={cn(
                    "tabular-nums",
                    active ? "text-fg-secondary" : "text-fg-muted",
                  )}
                >
                  {count}
                </span>
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
        aria-activedescendant={
          selectedKey && orderedRows.some((row) => row.key === selectedKey)
            ? `${idPrefix}-${selectedKey}`
            : undefined
        }
        data-activity-inbox=""
        onKeyDown={handleKeyDown}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => {
          setHovering(false);
          setFrozen(null);
        }}
        className="fd-focus-inset"
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
          <div key={group.key} role="group" aria-label={group.label}>
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
