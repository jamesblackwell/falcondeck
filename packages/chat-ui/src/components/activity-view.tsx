import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Check, CircleAlert, Play, X } from "lucide-react";

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

const SECTION_META: Record<
  ActivitySection,
  { title: string; description: string; icon: typeof Activity; tone: string }
> = {
  blocked: {
    title: "Blocked",
    description: "Waiting for your approval or answer",
    icon: CircleAlert,
    tone: "text-warning",
  },
  failed: {
    title: "Failed",
    description: "Runs that need acknowledging",
    icon: X,
    tone: "text-danger",
  },
  ready: {
    title: "Ready for you",
    description: "Finished turns you have not read",
    icon: Check,
    tone: "text-info",
  },
  running: {
    title: "Running",
    description: "Work in progress",
    icon: Play,
    tone: "text-success",
  },
};

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

    return (
      <article
        className={cn(
          "rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2 p-4 shadow-[var(--fd-shadow-sm)]",
          offline && "opacity-60",
        )}
        data-activity-thread={entry.thread.id}
      >
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => onOpenThread(entry.workspaceId, entry.thread.id)}
            className="fd-focus min-w-0 flex-1 rounded-[var(--fd-radius-sm)] text-left"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[length:var(--fd-text-base)] font-medium text-fg-primary">
                {entry.thread.title}
              </span>
              {host ? (
                <Badge variant={offline ? "danger" : "default"}>
                  {host.name}
                  {offline ? " · Offline" : ""}
                </Badge>
              ) : null}
            </span>
            <span className="mt-1 block text-[length:var(--fd-text-xs)] text-fg-muted">
              {entry.projectLabel} · {timeAgo(entry.thread.updated_at, nowMs)}
            </span>
            {reason ? (
              <span className="mt-2 block whitespace-pre-wrap text-[length:var(--fd-text-sm)] text-fg-secondary">
                {reason}
              </span>
            ) : null}
          </button>
          {entry.section === "failed" || entry.section === "ready" ? (
            <span title={offline ? "Host offline" : undefined}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={offline}
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

        {entry.section === "blocked" ? (
          <div className="mt-4" title={offline ? "Host offline" : undefined}>
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <header className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-3">
        <div>
          <h1 className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
            Activity
          </h1>
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            Across all projects and hosts
          </p>
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

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-8">
        <div className="mx-auto w-full max-w-[720px] space-y-8">
          {attentionCount === 0 ? (
            <EmptyState
              icon={<Activity className="h-6 w-6" />}
              title="All caught up"
              description={
                runningCount > 0
                  ? `${runningCount} running quietly`
                  : "Nothing needs your attention"
              }
              action={
                onNewThread ? (
                  <Button onClick={onNewThread}>New thread</Button>
                ) : undefined
              }
              className="rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2"
            />
          ) : null}

          {SECTION_ORDER.map(
            (section) => {
              const sectionEntries = sections.get(section) ?? [];
              if (sectionEntries.length === 0) return null;
              const meta = SECTION_META[section];
              const Icon = meta.icon;
              return (
                <section key={section} aria-labelledby={`activity-${section}`}>
                  <div className="mb-3 flex items-center gap-2">
                    <Icon
                      aria-hidden="true"
                      className={cn("h-4 w-4", meta.tone)}
                    />
                    <div className="min-w-0 flex-1">
                      <h2
                        id={`activity-${section}`}
                        className="text-[length:var(--fd-text-sm)] font-semibold text-fg-primary"
                      >
                        {meta.title}
                      </h2>
                      <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                        {meta.description}
                      </p>
                    </div>
                    <Badge variant="default">{sectionEntries.length}</Badge>
                  </div>
                  <div className="space-y-3">
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
