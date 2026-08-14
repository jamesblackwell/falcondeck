import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Activity, Check, CircleAlert, Plus, Play, X } from "lucide-react";

import {
  collectActivityEntries,
  type ActivityEntry,
  type ActivitySection,
  type InteractiveRequest,
  type InteractiveResponsePayload,
  type ProjectGroup,
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
  onClose: () => void;
  onNewThread?: () => void;
};

type ResolvedEntry = {
  entry: ActivityEntry;
  request: InteractiveRequest;
};

/** Per-section tone. Everything visual keys off `toneVar` through --fd-tone,
 *  so palettes and light mode carry through without a hard-coded color. */
const SECTION_META: Record<
  ActivitySection,
  {
    title: string;
    description: string;
    icon: typeof Activity;
    tone: string;
    toneVar: string;
    glyph: string;
  }
> = {
  blocked: {
    title: "Blocked",
    description: "Waiting for your approval or answer",
    icon: CircleAlert,
    tone: "text-warning",
    toneVar: "var(--fd-warning)",
    glyph: "?",
  },
  failed: {
    title: "Failed",
    description: "Runs that need acknowledging",
    icon: X,
    tone: "text-danger",
    toneVar: "var(--fd-danger)",
    glyph: "✗",
  },
  ready: {
    title: "Ready for you",
    description: "Finished turns you have not read",
    icon: Check,
    tone: "text-info",
    toneVar: "var(--fd-info)",
    glyph: "✓",
  },
  running: {
    title: "Running",
    description: "Work in progress",
    icon: Play,
    tone: "text-success",
    toneVar: "var(--fd-success)",
    glyph: "›",
  },
};

const SUMMARY_STATS: readonly {
  section: ActivitySection;
  label: string;
  tone: string;
}[] = [
  { section: "blocked", label: "Needs response", tone: "text-warning" },
  { section: "failed", label: "Failed", tone: "text-danger" },
  { section: "ready", label: "Ready", tone: "text-info" },
  { section: "running", label: "Running", tone: "text-success" },
];

/** Counters read as instrument digits: fixed width, never a bare "0". */
function padCount(count: number) {
  return count < 10 ? `0${count}` : String(count);
}

function entryKey(entry: ActivityEntry) {
  return `${entry.workspaceId}:${entry.thread.id}`;
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
    const running = entry.section === "running";

    return (
      <article
        style={{ "--fd-tone": meta.toneVar } as CSSProperties}
        className={cn(
          "fd-tone-edge fd-terminal-card group flex flex-col rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 shadow-[var(--fd-shadow-sm)]",
          entry.section !== "blocked" && "h-36 overflow-hidden",
          offline && "opacity-60",
        )}
        data-activity-thread={entry.thread.id}
      >
        {/* Terminal chrome: origin, host, and age — never the payload. The
            interaction fill separates from the card body in both light and
            dark, where a fixed surface step only works in one. */}
        <div className="flex shrink-0 items-center gap-2 rounded-t-[var(--fd-radius-lg)] border-b border-border-subtle bg-[color:var(--fd-interactive-hover)] px-3 py-1.5">
          <span
            aria-hidden="true"
            className={cn("fd-led shrink-0", running && "fd-led--pulse")}
          />
          <span className="fd-microlabel min-w-0 flex-1 truncate text-fg-muted">
            {entry.projectLabel}
          </span>
          {host ? (
            <Badge
              variant={offline ? "danger" : "default"}
              className="fd-microlabel max-w-[45%] shrink truncate rounded-[var(--fd-radius-sm)] px-1.5"
            >
              {host.name}
              {offline ? " · Offline" : ""}
            </Badge>
          ) : null}
          <span className="fd-microlabel shrink-0 tabular-nums text-fg-faint">
            {timeAgo(entry.thread.updated_at, nowMs)}
          </span>
          {entry.section === "failed" || entry.section === "ready" ? (
            <span
              className="-mr-1.5 shrink-0"
              title={offline ? "Host offline" : undefined}
            >
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={offline}
                className="fd-microlabel h-6 px-1.5 opacity-70 transition-opacity group-hover:opacity-100"
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
            "fd-focus-inset flex min-h-0 flex-col items-start gap-1.5 px-3.5 py-2.5 text-left",
            entry.section !== "blocked" && "flex-1",
          )}
        >
          <span className="w-full truncate text-[length:var(--fd-text-base)] font-medium text-fg-primary">
            {entry.thread.title}
          </span>
          {reason ? (
            /* Recessed screen: the fixed card height reads as terminal void
               rather than dead space, however short the last line was. */
            <span className="flex min-h-0 w-full flex-1 items-start gap-1.5 overflow-hidden rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-0 px-2 py-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  "shrink-0 font-mono text-[length:var(--fd-text-xs)] leading-relaxed text-[color:var(--fd-tone)]",
                  running && "fd-prompt--live",
                )}
              >
                {meta.glyph}
              </span>
              <span className="line-clamp-3 min-w-0 break-words whitespace-pre-wrap font-mono text-[length:var(--fd-text-xs)] leading-relaxed text-fg-secondary">
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
              <div className="rounded-[var(--fd-radius-lg)] border border-warning/20 bg-warning-muted px-4 py-3 text-[length:var(--fd-text-sm)] text-warning">
                Loading request…
              </div>
            )}
          </div>
        ) : null}

        {running ? <span aria-hidden="true" className="fd-scan" /> : null}
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
    previous.resolvedRequest?.request_id === next.resolvedRequest?.request_id &&
    previous.onOpenThread === next.onOpenThread &&
    previous.onMarkThreadRead === next.onMarkThreadRead &&
    previous.onRespond === next.onRespond,
);

export const ActivityView = memo(function ActivityView({
  groups,
  interactiveRequests,
  workspaceHosts = {},
  onOpenThread,
  onInteractiveResponse,
  onMarkThreadRead,
  onClose,
  onNewThread,
}: ActivityViewProps) {
  const [nowMs, setNowMs] = useState(Date.now);
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

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

  return (
    <div className="fd-grid-canvas relative flex h-full min-h-0 flex-col bg-surface-0">
      <header
        data-tauri-drag-region="deep"
        className="relative z-[1] flex shrink-0 items-center justify-between border-b border-border-subtle bg-surface-1/70 px-5 py-3 backdrop-blur-sm"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            style={{ "--fd-tone": "var(--fd-accent)" } as CSSProperties}
            className="fd-led fd-led--pulse"
          />
          <div>
            <h1 className="text-[length:var(--fd-text-lg)] font-semibold tracking-[var(--fd-tracking-tight)] text-fg-primary">
              Activity
            </h1>
            <p className="fd-microlabel text-fg-muted">
              Across all projects and hosts
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Close Activity"
          onClick={onClose}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      </header>

      <div className="relative z-[1] min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto w-full max-w-[1440px] space-y-7">
          <section
            aria-label="Activity summary"
            style={
              {
                "--fd-tone": attentionCount
                  ? "var(--fd-warning)"
                  : "var(--fd-accent)",
              } as CSSProperties
            }
            className="fd-tone-edge flex flex-col gap-4 overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 px-4 py-3 shadow-[var(--fd-shadow-sm)] md:flex-row md:items-center"
          >
            <div className="flex min-w-0 items-center gap-3 md:w-56 md:shrink-0">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--fd-radius-md)] border border-[color:color-mix(in_srgb,var(--fd-tone)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--fd-tone)_10%,transparent)] text-[color:var(--fd-tone)]">
                <Activity aria-hidden="true" className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  {attentionCount === 0
                    ? "All caught up"
                    : `${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`}
                </p>
                <p className="fd-microlabel truncate text-fg-muted">
                  {runningCount > 0
                    ? `${runningCount} running quietly`
                    : "No active runs"}
                </p>
              </div>
            </div>

            {/* Instrument row. A zeroed counter drops to a flat, faint digit so
                the only things that glow are the ones with work behind them. */}
            <dl className="grid min-w-0 flex-1 grid-cols-2 gap-px overflow-hidden rounded-[var(--fd-radius-md)] border border-border-subtle bg-border-subtle sm:grid-cols-4">
              {SUMMARY_STATS.map((stat) => {
                const count = summaryCounts.get(stat.section) ?? 0;
                return (
                  <div
                    key={stat.section}
                    style={
                      {
                        "--fd-tone": SECTION_META[stat.section].toneVar,
                      } as CSSProperties
                    }
                    className="relative flex min-w-0 items-baseline justify-between gap-2 bg-surface-0 px-3 py-2 sm:block"
                  >
                    <dt className="fd-microlabel truncate text-fg-muted">
                      {stat.label}
                    </dt>
                    <dd
                      className={cn(
                        "mt-1 font-mono text-[length:var(--fd-text-xl)] font-semibold leading-none tabular-nums",
                        count > 0
                          ? cn(stat.tone, "fd-stat-live")
                          : "text-fg-faint",
                      )}
                    >
                      {padCount(count)}
                    </dd>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[color:var(--fd-tone)]"
                      style={{ opacity: count > 0 ? 0.55 : 0.1 }}
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
              const Icon = meta.icon;
              return (
                <section
                  key={section}
                  aria-labelledby={`activity-${section}`}
                  style={{ "--fd-tone": meta.toneVar } as CSSProperties}
                >
                  {/* Channel divider: label, hairline run-out, count. */}
                  <div className="mb-3 flex items-center gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)] border border-[color:color-mix(in_srgb,var(--fd-tone)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--fd-tone)_10%,transparent)]">
                      <Icon
                        aria-hidden="true"
                        className={cn("h-3 w-3", meta.tone)}
                      />
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
        </div>
      </div>
    </div>
  );
});
