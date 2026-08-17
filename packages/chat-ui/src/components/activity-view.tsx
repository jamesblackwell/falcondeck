import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Check, ChevronRight, PanelsTopLeft, Plus, X } from "lucide-react";

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
import { Badge, Button, EmptyState, cn } from "@falcondeck/ui";

import { InteractiveRequestCard } from "./interactive-request-card";

const RELATIVE_TIME_TICK_MS = 60_000;
const RESOLVED_HOLD_MS = 1_500;
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
   * focused whenever the app is. Drives the keyboard-ready indicator: across
   * two screens you cannot otherwise tell which window is listening.
   */
  windowFocused?: boolean;
};

type ResolvedEntry = {
  entry: ActivityEntry;
  request: InteractiveRequest;
};

/**
 * Per-section tone. Everything visual keys off `toneVar` through --fd-tone,
 * so palettes and light mode carry through without a hard-coded color.
 *
 * Three hues, and only three: amber and red are alarms, and green is the
 * brand accent spent on the one pile that wants you. Running is the ambient
 * majority, so it is neutral — colouring it made a busy queue read as a
 * wall of green and left the accent meaning nothing.
 */
const SECTION_META: Record<
  ActivitySection,
  {
    title: string;
    description: string;
    /** Lane digit — the section's slot in SECTION_ORDER, bound to 1–4. */
    lane: number;
    tone: string;
    toneVar: string;
    glyph: string;
  }
> = {
  blocked: {
    title: "Blocked",
    description: "Waiting for your approval or answer",
    lane: 1,
    tone: "text-warning",
    toneVar: "var(--fd-warning)",
    glyph: "?",
  },
  failed: {
    title: "Failed",
    description: "Runs that need acknowledging",
    lane: 2,
    tone: "text-danger",
    toneVar: "var(--fd-danger)",
    glyph: "✗",
  },
  ready: {
    title: "Ready for you",
    description: "Finished turns you have not read",
    lane: 3,
    tone: "text-accent",
    toneVar: "var(--fd-accent)",
    glyph: "✓",
  },
  running: {
    title: "Running",
    description: "Work in progress",
    lane: 4,
    tone: "text-fg-muted",
    toneVar: "var(--fd-fg-3)",
    glyph: "›",
  },
};

const SUMMARY_STATS: readonly {
  section: ActivitySection;
  label: string;
}[] = [
  { section: "blocked", label: "Needs response" },
  { section: "failed", label: "Failed" },
  { section: "ready", label: "Ready" },
  { section: "running", label: "Running" },
];

/**
 * Left hand on the keys, right hand free. WASD moves, E interacts, Q
 * dismisses, 1–4 pick a lane — the bindings anyone who has played a game
 * already knows. Arrows and j/k stay wired for everyone else.
 */
const KEY_HINTS: readonly {
  key: string;
  /** The non-gaming binding for the same action, listed behind `?`. */
  alt?: string;
  label: string;
  description: string;
  /** Shown in the always-on status bar; the rest live behind `?`. */
  compact?: boolean;
}[] = [
  {
    key: "W A S D",
    alt: "← ↑ ↓ →",
    label: "move",
    description: "Move across the grid",
    compact: true,
  },
  {
    key: "E",
    alt: "↵ / space",
    label: "open",
    description: "Open the selected thread",
    compact: true,
  },
  {
    key: "Q",
    alt: "R",
    label: "clear",
    description: "Mark the selected thread read",
    compact: true,
  },
  { key: "1–4", label: "lane", description: "Jump to a lane", compact: true },
  { key: "J / K", label: "scan", description: "Scan the queue in order" },
  { key: "T", label: "recent", description: "Show what finished recently" },
  { key: "?", alt: "H", label: "keys", description: "Show this list" },
  { key: "esc", label: "back", description: "Clear the selection" },
];

/** Counters read as instrument digits: fixed width, never a bare "0". */
function padCount(count: number) {
  return count < 10 ? `0${count}` : String(count);
}

function entryKey(entry: ActivityEntry) {
  return `${entry.workspaceId}:${entry.thread.id}`;
}

function recentKey(entry: RecentEntry) {
  return `recent:${entry.workspaceId}:${entry.thread.id}`;
}

type NavigationDirection = "left" | "right" | "up" | "down";

/** Follow the cards as rendered, including responsive two/three-column grids. */
function spatialNeighbor(
  root: HTMLElement | null,
  selectedKey: string,
  direction: NavigationDirection,
) {
  if (!root) return null;
  const current = root.querySelector<HTMLElement>(
    `[data-activity-key="${CSS.escape(selectedKey)}"]`,
  );
  if (!current) return null;
  const origin = current.getBoundingClientRect();
  const originX = origin.left + origin.width / 2;
  const originY = origin.top + origin.height / 2;
  let best: { key: string; score: number } | null = null;

  for (const candidate of root.querySelectorAll<HTMLElement>(
    "[data-activity-key]",
  )) {
    if (candidate === current) continue;
    const rect = candidate.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - originX;
    const dy = rect.top + rect.height / 2 - originY;
    const horizontal = direction === "left" || direction === "right";
    const forward = direction === "left"
      ? dx < -1
      : direction === "right"
        ? dx > 1
        : direction === "up"
          ? dy < -1
          : dy > 1;
    if (!forward) continue;
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
    const crossAxis = horizontal ? Math.abs(dy) : Math.abs(dx);
    const score = primary + crossAxis * 4;
    const key = candidate.dataset.activityKey;
    if (key && (!best || score < best.score)) best = { key, score };
  }
  return best?.key ?? null;
}

/** Typing in a card's answer box must not steal the movement keys. */
function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

/** A focused control answers Enter and space itself; don't open twice. */
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

/** Keep actionable rows under the pointer while snapshots churn. */
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
        request.created_at === other.created_at
      );
    })
  );
}

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
    const reason =
      entry.section === "failed"
        ? (entry.thread.last_error ?? "The run failed")
        : entry.section === "ready"
          ? (entry.thread.last_message_preview ?? "Turn finished")
          : entry.section === "running"
            ? (entry.thread.last_tool ??
              entry.thread.last_message_preview ??
              "Working…")
            : null;

    const meta = SECTION_META[entry.section];

    return (
      <article
        style={{ "--fd-tone": meta.toneVar } as CSSProperties}
        className={cn(
          "fd-tone-edge fd-terminal-card fd-reticle group flex flex-col rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1",
          // Taller on wide screens, where the extra room buys readout lines
          // rather than empty card.
          entry.section !== "blocked" && "h-36 overflow-hidden xl:h-40",
          offline && "opacity-60",
          selected &&
            "border-[color:color-mix(in_srgb,var(--fd-accent)_50%,transparent)]",
        )}
        data-activity-thread={entry.thread.id}
        data-activity-key={entryKey(entry)}
        data-selected={selected ? "true" : undefined}
      >
        {/* Terminal chrome: origin, host, and age — never the payload. */}
        <div className="fd-chrome-fill flex shrink-0 items-center gap-2.5 rounded-t-[var(--fd-radius-md)] border-b border-border-subtle px-3.5 py-1.5">
          <span aria-hidden="true" className="fd-led shrink-0" />
          <span className="fd-readout min-w-0 flex-1 truncate text-fg-muted">
            {entry.projectLabel}
          </span>
          {host ? (
            <Badge
              variant={offline ? "danger" : "default"}
              className="fd-readout max-w-[45%] shrink truncate rounded-[var(--fd-radius-sm)] px-1.5"
            >
              {host.name}
              {offline ? " · Offline" : ""}
            </Badge>
          ) : null}
          <span className="fd-readout shrink-0 tabular-nums text-fg-muted">
            {timeAgo(entry.thread.updated_at, nowMs)}
          </span>
          {entry.section === "failed" || entry.section === "ready" ? (
            <span
              className="-mr-2 shrink-0"
              title={offline ? "Host offline" : undefined}
            >
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={offline}
                className="h-6 px-2 text-fg-muted"
                onClick={() => {
                  void Promise.resolve(
                    onMarkThreadRead(entry.workspaceId, entry.thread.id),
                  ).catch(() => {});
                }}
              >
                Mark read
              </Button>
            </span>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => onOpenThread(entry.workspaceId, entry.thread.id)}
          className={cn(
            "fd-focus-inset flex min-h-0 flex-col items-start gap-2 px-3.5 py-2.5 text-left",
            entry.section !== "blocked" && "flex-1",
          )}
        >
          <span className="w-full truncate text-[length:var(--fd-text-base)] font-medium text-fg-primary">
            {entry.thread.title}
          </span>
          {reason ? (
            /* Recessed screen: the fixed card height reads as terminal void
               rather than dead space, however short the last line was. */
            <span className="flex min-h-0 w-full flex-1 items-start gap-2 overflow-hidden rounded-[var(--fd-radius-sm)] border border-border-subtle bg-surface-0 px-2.5 py-1.5">
              <span
                aria-hidden="true"
                className="shrink-0 font-mono text-[length:var(--fd-text-xs)] leading-relaxed text-[color:var(--fd-tone)]"
              >
                {meta.glyph}
              </span>
              <span className="line-clamp-3 min-w-0 break-words whitespace-pre-wrap font-mono text-[length:var(--fd-text-xs)] leading-relaxed text-fg-secondary xl:line-clamp-4">
                {reason}
              </span>
            </span>
          ) : null}
        </button>

        {entry.section === "blocked" ? (
          <div
            className="px-3.5 pb-3.5"
            title={offline ? "Host offline" : undefined}
          >
            {request ? (
              <fieldset
                disabled={offline}
                className="m-0 min-w-0 border-0 p-0"
              >
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
              <div className="rounded-[var(--fd-radius-md)] border border-warning/20 bg-warning-muted px-4 py-3 text-[length:var(--fd-text-sm)] text-warning">
                Loading request…
              </div>
            )}
          </div>
        ) : null}
      </article>
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
  open: boolean;
  nowMs: number;
  selectedKey: string | null;
  onToggle: () => void;
  onOpenThread: ActivityViewProps["onOpenThread"];
};

/**
 * The trail behind the queue. Collapsed by default — it is reference, not
 * work — and a dense list rather than cards, because the question it answers
 * is "what did I just finish?", not "what does it say?".
 */
const RecentTrail = memo(function RecentTrail({
  entries,
  open,
  nowMs,
  selectedKey,
  onToggle,
  onOpenThread,
}: RecentTrailProps) {
  if (entries.length === 0) return null;

  return (
    <section
      aria-labelledby="activity-recent"
      style={{ "--fd-tone": "var(--fd-fg-3)" } as CSSProperties}
    >
      <div className="mb-2.5 flex items-center gap-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="activity-recent-list"
          className="fd-focus flex min-w-0 items-center gap-2 rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:text-fg-primary"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform duration-[var(--fd-duration-fast)]",
              open && "rotate-90",
            )}
          />
          <h2
            id="activity-recent"
            className="fd-microlabel fd-microlabel--md shrink-0 font-semibold text-fg-primary"
          >
            Recent
          </h2>
          <span className="hidden truncate text-[length:var(--fd-text-xs)] text-fg-muted sm:block">
            Finished in the last few hours
          </span>
        </button>
        <span
          aria-hidden="true"
          className="h-px min-w-6 flex-1 bg-[linear-gradient(90deg,color-mix(in_srgb,var(--fd-tone)_28%,transparent),transparent)]"
        />
        <span className="fd-microlabel shrink-0 tabular-nums text-fg-muted">
          {padCount(entries.length)}
        </span>
      </div>

      {open ? (
        <ul
          id="activity-recent-list"
          className="overflow-hidden rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1"
        >
          {entries.map((entry) => {
            const key = recentKey(entry);
            return (
              <li
                key={key}
                data-activity-key={key}
                data-selected={selectedKey === key ? "true" : undefined}
                className={cn(
                  "border-b border-l-2 border-l-transparent border-border-subtle last:border-b-0",
                  // Same accent cursor the cards wear, at list scale.
                  selectedKey === key &&
                    "border-l-accent bg-[color:var(--fd-interactive-hover)]",
                )}
              >
                <button
                  type="button"
                  onClick={() =>
                    onOpenThread(entry.workspaceId, entry.thread.id)
                  }
                  className="fd-focus-inset flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-[color:var(--fd-interactive-hover)]"
                >
                  <Check
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 text-fg-faint"
                  />
                  <span className="min-w-0 max-w-[42%] truncate text-[length:var(--fd-text-sm)] text-fg-secondary">
                    {entry.thread.title}
                  </span>
                  {entry.thread.last_message_preview ? (
                    <span
                      className="hidden min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)] text-fg-muted sm:block"
                      title={entry.thread.last_message_preview}
                    >
                      {entry.thread.last_message_preview}
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1" />
                  )}
                  <span className="fd-readout shrink-0 truncate text-fg-muted">
                    {entry.projectLabel}
                  </span>
                  <span className="fd-readout w-8 shrink-0 text-right tabular-nums text-fg-muted">
                    {timeAgo(entry.thread.updated_at, nowMs)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
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
  const [recentOpen, setRecentOpen] = useState(false);
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
  const summaryCounts = new Map(
    SECTION_ORDER.map((section) => [
      section,
      sections.get(section)?.length ?? 0,
    ]),
  );

  const recentEntries = useMemo(
    () => collectRecentEntries(groups, interactiveRequests, { nowMs }),
    [groups, interactiveRequests, nowMs],
  );

  /* ================================================================
     Keyboard model.

     Activity is a grid you fly around, so it takes the bindings your
     left hand already knows: WASD to move, E to open, Q to clear,
     1–4 to drop into a lane, T for the trail. Arrows and j/k stay
     wired for anyone who reaches for those instead. Handled on the
     window rather than per-card so the keys work the moment Activity
     has focus, without the user first clicking a card.
     ================================================================ */
  const selectable = useMemo(() => {
    const rows: {
      key: string;
      section?: ActivitySection;
      entry?: ActivityEntry;
      recent?: RecentEntry;
    }[] = [];
    for (const section of SECTION_ORDER) {
      for (const entry of sections.get(section) ?? []) {
        rows.push({ key: entryKey(entry), section, entry });
      }
    }
    if (recentOpen) {
      for (const recent of recentEntries) {
        rows.push({ key: recentKey(recent), recent });
      }
    }
    return rows;
  }, [recentEntries, recentOpen, sections]);

  // A selection that scrolled out of the queue (answered, marked read) must
  // not linger as a highlight on nothing.
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
    // Guarded: jsdom has no layout, and neither do headless webviews.
    if (row instanceof HTMLElement && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [selectedKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      // Leave every system and app shortcut (⌘R, ⌘W, ⌘1…) alone.
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

      const moveSpatially = (direction: NavigationDirection) => {
        event.preventDefault();
        if (selectable.length === 0) return;
        if (!selectedKey) {
          setSelectedKey(selectable[0]?.key ?? null);
          return;
        }
        const next = spatialNeighbor(scrollRef.current, selectedKey, direction);
        if (next) setSelectedKey(next);
      };

      /** Drop onto the first card of a lane, whatever it holds today. */
      const jumpToLane = (lane: number) => {
        event.preventDefault();
        const section = SECTION_ORDER[lane - 1];
        const row = selectable.find((entry) => entry.section === section);
        if (row) setSelectedKey(row.key);
      };

      const openSelected = () => {
        // Enter and space belong to whatever control has focus first.
        if (event.key !== "e" && event.key !== "E") {
          if (isActivatableTarget(event.target)) return;
        }
        const row = selectable.find((entry) => entry.key === selectedKey);
        const target = row?.entry ?? row?.recent;
        if (!target) return;
        event.preventDefault();
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
        case "w":
        case "W":
          return moveSpatially("up");
        case "ArrowLeft":
        case "a":
        case "A":
          return moveSpatially("left");
        case "ArrowDown":
        case "s":
        case "S":
          return moveSpatially("down");
        case "ArrowRight":
        case "d":
        case "D":
          return moveSpatially("right");
        case "j":
        case "J":
          return step(1);
        case "k":
        case "K":
          return step(-1);
        case "Enter":
        case " ":
        case "e":
        case "E":
          return openSelected();
        case "q":
        case "Q":
        case "r":
        case "R":
          return markSelectedRead();
        case "t":
        case "T":
          event.preventDefault();
          return setRecentOpen((current) => !current);
        case "1":
        case "2":
        case "3":
        case "4":
          return jumpToLane(Number(event.key));
        case "?":
        case "h":
        case "H":
          event.preventDefault();
          return setShowKeys((current) => !current);
        case "Escape":
          event.preventDefault();
          if (showKeys) return setShowKeys(false);
          if (selectedKey) return setSelectedKey(null);
          // In a detached window Escape hands the keyboard back to the app
          // rather than closing what the user deliberately pulled out.
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
    selectable,
    selectedKey,
    showKeys,
  ]);

  return (
    <div className="fd-grid-canvas relative flex h-full min-h-0 flex-col bg-surface-0">
      <header
        data-tauri-drag-region="deep"
        className={cn(
          // Title and strapline share a line: this bar is a label, not a
          // masthead, and every pixel it takes is one the queue doesn't get.
          "relative z-[1] flex shrink-0 items-center justify-between gap-4 border-b border-border-subtle bg-surface-1/70 px-5 py-2 backdrop-blur-sm",
          trafficLightInset && "pl-[86px]",
        )}
      >
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="shrink-0 text-[length:var(--fd-text-md)] font-semibold tracking-[var(--fd-tracking-tight)] text-fg-primary">
            Activity
          </h1>
          <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
            Across all projects and hosts
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          {onPopOut ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-2 text-fg-muted"
              title="Keep Activity open in its own window"
              onClick={onPopOut}
            >
              <PanelsTopLeft aria-hidden="true" className="h-4 w-4" />
              Open in new window
            </Button>
          ) : null}
          {onClose ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Close Activity"
              onClick={onClose}
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </header>

      <div
        ref={scrollRef}
        className="relative z-[1] min-h-0 flex-1 overflow-y-auto px-5 py-5"
      >
        <div className="mx-auto w-full max-w-[1440px] space-y-6">
          <section
            aria-label="Activity summary"
            style={
              {
                "--fd-tone": attentionCount
                  ? "var(--fd-warning)"
                  : "var(--fd-accent)",
              } as CSSProperties
            }
            className="fd-tone-edge flex flex-col gap-4 overflow-hidden rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1 px-4 py-3 md:flex-row md:items-center"
          >
            <div className="flex min-w-0 items-center gap-2.5 md:w-52 md:shrink-0">
              <span aria-hidden="true" className="fd-led shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  {attentionCount === 0
                    ? "All caught up"
                    : `${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`}
                </p>
                <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                  {runningCount > 0
                    ? `${runningCount} running quietly`
                    : "No active runs"}
                </p>
              </div>
            </div>

            {/* Instrument row. A zeroed counter drops to a flat, faint digit so
                the only lit ones are those with work behind them, and each
                tile wears the lane digit that jumps to it. */}
            <dl className="grid min-w-0 flex-1 grid-cols-2 gap-px overflow-hidden rounded-[var(--fd-radius-sm)] border border-border-subtle bg-border-subtle sm:grid-cols-4">
              {SUMMARY_STATS.map((stat) => {
                const meta = SECTION_META[stat.section];
                const count = summaryCounts.get(stat.section) ?? 0;
                return (
                  <div
                    key={stat.section}
                    style={{ "--fd-tone": meta.toneVar } as CSSProperties}
                    className="relative flex min-w-0 items-baseline justify-between gap-2 bg-surface-0 px-3 py-2 sm:block"
                  >
                    <dt className="flex min-w-0 items-center gap-1.5">
                      <span aria-hidden="true" className="fd-keycap shrink-0">
                        {meta.lane}
                      </span>
                      <span className="fd-microlabel truncate text-fg-muted">
                        {stat.label}
                      </span>
                    </dt>
                    <dd
                      className={cn(
                        "mt-1 font-mono text-[length:var(--fd-text-lg)] font-semibold leading-none tabular-nums",
                        count > 0 ? meta.tone : "text-fg-faint",
                      )}
                    >
                      {padCount(count)}
                    </dd>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[color:var(--fd-tone)]"
                      style={{ opacity: count > 0 ? 0.4 : 0.06 }}
                    />
                  </div>
                );
              })}
            </dl>

            {onNewThread ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="shrink-0"
                onClick={onNewThread}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                New thread
              </Button>
            ) : null}
          </section>

          {visibleEntries.length === 0 ? (
            <EmptyState
              title="No active work"
              description="Tasks that need attention or are still running will appear here."
              className="py-16"
            />
          ) : null}

          {SECTION_ORDER.map(
            (section) => {
              const sectionEntries = sections.get(section) ?? [];
              if (sectionEntries.length === 0) return null;
              const meta = SECTION_META[section];
              return (
                <section
                  key={section}
                  aria-labelledby={`activity-${section}`}
                  data-activity-lane={meta.lane}
                  style={{ "--fd-tone": meta.toneVar } as CSSProperties}
                >
                  {/* Channel divider: lane digit, label, hairline run-out,
                      count. The digit is the key that jumps here. */}
                  <div className="mb-2.5 flex items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="fd-keycap shrink-0 border-[color:color-mix(in_srgb,var(--fd-tone)_35%,transparent)] text-[color:var(--fd-tone)]"
                    >
                      {meta.lane}
                    </span>
                    <h2
                      id={`activity-${section}`}
                      className="fd-microlabel fd-microlabel--md shrink-0 font-semibold text-fg-primary"
                    >
                      {meta.title}
                    </h2>
                    <p className="hidden min-w-0 truncate text-[length:var(--fd-text-xs)] text-fg-muted sm:block">
                      {meta.description}
                    </p>
                    <span
                      aria-hidden="true"
                      className="h-px min-w-6 flex-1 bg-[linear-gradient(90deg,color-mix(in_srgb,var(--fd-tone)_32%,transparent),transparent)]"
                    />
                    <span className="fd-microlabel shrink-0 tabular-nums text-fg-muted">
                      {padCount(sectionEntries.length)}
                    </span>
                  </div>
                  <div
                    data-activity-grid={section}
                    className={cn(
                      "grid items-start gap-3 lg:grid-cols-2",
                      section !== "blocked" && "2xl:grid-cols-3",
                    )}
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
                  </div>
                </section>
              );
            },
          )}

          <RecentTrail
            entries={recentEntries}
            open={recentOpen}
            nowMs={nowMs}
            selectedKey={selectedKey}
            onToggle={() => setRecentOpen((current) => !current)}
            onOpenThread={onOpenThread}
          />
        </div>
      </div>

      {/* Status bar. Doubles as the focus tell: across two screens the only
          reliable way to know which window the keyboard is talking to. */}
      <footer
        className={cn(
          "relative z-[1] flex shrink-0 items-center gap-3 border-t border-border-subtle bg-surface-1/70 px-5 py-1.5 backdrop-blur-sm transition-opacity",
          windowFocused === false && "opacity-45",
        )}
      >
        <span
          aria-hidden="true"
          style={
            {
              "--fd-tone":
                windowFocused === false ? "var(--fd-fg-4)" : "var(--fd-accent)",
            } as CSSProperties
          }
          className="fd-led shrink-0"
        />
        <span className="fd-microlabel shrink-0 text-fg-muted">
          {windowFocused === false ? "Click to focus" : "Keyboard ready"}
        </span>
        <span
          aria-hidden="true"
          className="h-px min-w-4 flex-1 bg-border-subtle"
        />
        <ul className="flex shrink-0 items-center gap-3">
          {KEY_HINTS.filter((hint) => hint.compact).map((hint) => (
            <li key={hint.key} className="hidden items-center gap-1.5 md:flex">
              <kbd className="fd-keycap">{hint.key}</kbd>
              <span className="fd-microlabel text-fg-muted">{hint.label}</span>
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <kbd className="fd-keycap">?</kbd>
            <span className="fd-microlabel text-fg-muted">keys</span>
          </li>
        </ul>
      </footer>

      {showKeys ? (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="absolute inset-0 z-[2] flex items-center justify-center bg-[color:var(--fd-overlay)] p-8"
          onClick={() => setShowKeys(false)}
        >
          <div className="w-full max-w-sm rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 p-4 shadow-[var(--fd-shadow-lg)]">
            <p className="fd-microlabel fd-microlabel--md mb-3 font-semibold text-fg-primary">
              Keyboard
            </p>
            <dl className="space-y-2">
              {KEY_HINTS.filter(
                (hint) => hint.key !== "esc" || onReturnFocus || onClose,
              ).map((hint) => (
                <div
                  key={hint.key}
                  className="flex items-center justify-between gap-4"
                >
                  <dt className="text-[length:var(--fd-text-sm)] text-fg-secondary">
                    {hint.key === "esc" && onReturnFocus
                      ? "Back to the main app"
                      : hint.description}
                  </dt>
                  <dd className="flex shrink-0 items-center gap-1.5">
                    <kbd className="fd-keycap">{hint.key}</kbd>
                    {hint.alt ? (
                      <>
                        <span className="fd-microlabel text-fg-faint">or</span>
                        <kbd className="fd-keycap">{hint.alt}</kbd>
                      </>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
    </div>
  );
});
