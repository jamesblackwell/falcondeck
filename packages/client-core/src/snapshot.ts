import type {
  DaemonSnapshot,
  EventEnvelope,
  ImageInput,
  OperationalCondition,
  ServiceNotice,
  ThreadSummary,
} from "./types";
import {
  normalizeDaemonSnapshot,
  normalizeEventEnvelope,
  normalizeInteractiveRequest,
  normalizeScheduledTask,
  normalizeScheduledTaskRun,
  normalizeThreadSummary,
} from "./normalization";

export type SnapshotSelection = {
  workspaceId: string | null;
  threadId: string | null;
};

export type ReconcileSnapshotSelectionOptions = {
  preserveEmptyThreadSelection?: boolean;
};

/**
 * Resolves a thread only within the selected workspace boundary.
 *
 * Thread ids are normally globally unique, but clients can temporarily merge
 * snapshots from multiple daemons and can hold an old id while selection is
 * reconciling. Returning a thread from another workspace in that window leaks
 * its provider, transcript controls, and pending state into the new surface.
 */
export function threadForSelection(
  threads: readonly ThreadSummary[],
  workspaceId: string | null,
  threadId: string | null,
): ThreadSummary | null {
  if (!workspaceId || !threadId) return null;
  return (
    threads.find(
      (thread) => thread.id === threadId && thread.workspace_id === workspaceId,
    ) ?? null
  );
}

/** Cross-provider attachment ceiling. The daemon enforces the same limits
 * authoritatively; clients use them to fail before allocating relay payloads. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 7_500_000;
export const MAX_TOTAL_IMAGE_ATTACHMENT_BYTES = 10_000_000;

function base64PayloadByteSize(value: string): number | null {
  const comma = value.indexOf(",");
  if (comma < 0 || !/;base64(?:;|,)/i.test(value.slice(0, comma + 1)))
    return null;
  const encoded = value.slice(comma + 1).replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

export function imageInputByteSize(image: ImageInput): number | null {
  return image.url.trim().startsWith("data:")
    ? base64PayloadByteSize(image.url)
    : null;
}

function validateImageByteEntries(
  entries: readonly { name: string; bytes: number }[],
) {
  let total = 0;
  for (const entry of entries) {
    if (entry.bytes > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new Error(
        `${entry.name} is too large. Images must be 7.5 MB or smaller.`,
      );
    }
    total += entry.bytes;
  }
  if (total > MAX_TOTAL_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(
      "Those images are too large together. Attach no more than 10 MB at once.",
    );
  }
}

/** Validate already-materialized image inputs before queueing or relay encryption. */
export function validateImageAttachmentBudget(
  images: readonly ImageInput[],
): void {
  validateImageByteEntries(
    images.flatMap((image) => {
      const bytes = imageInputByteSize(image);
      return bytes == null
        ? []
        : [{ name: image.name?.trim() || "Image", bytes }];
    }),
  );
}

/** Highest-severity newest operational notice for one workspace. */
export function latestWorkspaceNotice(
  notices: readonly ServiceNotice[] | null | undefined,
  workspaceId: string | null | undefined,
  dismissedIds: ReadonlySet<string>,
): ServiceNotice | null {
  if (!workspaceId || !notices?.length) return null;
  let latestWarning: ServiceNotice | null = null;
  let latestInfo: ServiceNotice | null = null;
  for (let index = notices.length - 1; index >= 0; index -= 1) {
    const notice = notices[index];
    if (
      !notice ||
      notice.workspace_id !== workspaceId ||
      dismissedIds.has(notice.id)
    )
      continue;
    if (notice.level === "error") return notice;
    if (notice.level === "warning" && !latestWarning) latestWarning = notice;
    if (notice.level === "info" && !latestInfo) latestInfo = notice;
  }
  return latestWarning ?? latestInfo;
}

/** Dismisses one version of a condition; a later update becomes visible again. */
export function operationalConditionDismissalKey(
  condition: Pick<OperationalCondition, "id" | "updated_at">,
): string {
  return `${condition.id}:${condition.updated_at}`;
}

/** Active conditions for one workspace, highest severity and newest first. */
export function workspaceOperationalConditions(
  conditions: readonly OperationalCondition[] | null | undefined,
  legacyNotices: readonly ServiceNotice[] | null | undefined,
  workspaceId: string | null | undefined,
  dismissedVersions: ReadonlySet<string>,
): OperationalCondition[] {
  if (!workspaceId) return [];
  const current = (conditions ?? []).filter(
    (condition) => condition.workspace_id === workspaceId,
  );
  const candidates =
    current.length > 0
      ? current
      : (legacyNotices ?? [])
          .filter((notice) => notice.workspace_id === workspaceId)
          .map((notice) => ({
            id: notice.id,
            key: `legacy:${notice.id}`,
            workspace_id: notice.workspace_id,
            level: notice.level,
            message: notice.message,
            source: notice.raw_method,
            created_at: notice.created_at,
            updated_at: notice.created_at,
          }));
  const severity = { error: 2, warning: 1, info: 0 } as const;
  return candidates
    .filter(
      (condition) =>
        !dismissedVersions.has(operationalConditionDismissalKey(condition)) &&
        !dismissedVersions.has(condition.id),
    )
    .sort((left, right) => {
      const severityDifference = severity[right.level] - severity[left.level];
      if (severityDifference !== 0) return severityDifference;
      return right.updated_at.localeCompare(left.updated_at);
    });
}

function upsertWorkspace(
  workspaces: DaemonSnapshot["workspaces"],
  nextWorkspace: DaemonSnapshot["workspaces"][number],
) {
  const existing = workspaces.findIndex(
    (workspace) => workspace.id === nextWorkspace.id,
  );
  if (existing === -1) {
    return [nextWorkspace, ...workspaces];
  }

  return workspaces.map((workspace) =>
    workspace.id === nextWorkspace.id ? nextWorkspace : workspace,
  );
}

function upsertThread(
  threads: DaemonSnapshot["threads"],
  nextThread: DaemonSnapshot["threads"][number],
) {
  const existing = threads.findIndex((thread) => thread.id === nextThread.id);
  if (existing === -1) {
    // An update to an archived thread (mark_read etc.) must not resurrect it
    // into the sidebar.
    if (nextThread.is_archived) {
      return threads;
    }
    // Snapshots list threads newest-first, so a thread whose thread-started
    // event was missed still becomes visible at the top.
    return [nextThread, ...threads];
  }

  // A thread that just became archived leaves the list the same way it would
  // be absent from a fresh snapshot.
  if (nextThread.is_archived) {
    return threads.filter((thread) => thread.id !== nextThread.id);
  }

  // The daemon builds some thread updates on background tasks, so a summary
  // captured before a turn ended can be broadcast after the turn's own
  // terminal update. Applying it would roll the thread back to Running and
  // leave a spinner that never stops, because an idle thread emits nothing
  // more to correct it. Timestamps only move forward here, and updates that
  // deliberately preserve recency (pin, mark-read) carry the same value, so
  // only a strictly older summary is a stale one.
  const current = threads[existing];
  if (isStaleThreadSummary(current, nextThread)) {
    return threads;
  }

  return threads.map((thread) =>
    thread.id === nextThread.id ? nextThread : thread,
  );
}

const TERMINAL_THREAD_STATUSES = new Set<ThreadSummary["status"]>([
  "idle",
  "error",
]);

function isStaleThreadSummary(
  current: DaemonSnapshot["threads"][number] | undefined,
  next: DaemonSnapshot["threads"][number],
) {
  if (!current) return false;
  const currentAt = Date.parse(current.updated_at);
  const nextAt = Date.parse(next.updated_at);
  if (Number.isNaN(currentAt) || Number.isNaN(nextAt)) return false;
  if (nextAt < currentAt) return true;
  // Reviving a settled thread is the one transition a stale summary can make
  // that never self-corrects, so it has to clear a stricter bar than the rest.
  // The daemon stamps every real mutation with a fresh `updated_at`, so a
  // genuine new turn always reads strictly newer; a background task rebroadcast
  // of the pre-terminal summary reads equal. Only `waiting_for_input` is
  // exempt: answering an approval flips it back to Running while deliberately
  // preserving the thread's recency.
  return (
    nextAt === currentAt &&
    next.status === "running" &&
    TERMINAL_THREAD_STATUSES.has(current.status)
  );
}

/**
 * Applies a daemon event to the current snapshot state.
 * Shared by both desktop and remote-web apps.
 */
export function applySnapshotEvent(
  snapshot: DaemonSnapshot | null,
  event: EventEnvelope,
): DaemonSnapshot | null {
  const daemonEvent = normalizeEventEnvelope(event).event;
  if (daemonEvent.type === "snapshot") {
    return normalizeDaemonSnapshot(daemonEvent.snapshot);
  }
  if (!snapshot) return snapshot;
  switch (daemonEvent.type) {
    case "thread-started":
      return {
        ...snapshot,
        workspaces: snapshot.workspaces.map((workspace) =>
          workspace.id === daemonEvent.thread.workspace_id
            ? {
                ...workspace,
                current_thread_id: daemonEvent.thread.id,
                updated_at: daemonEvent.thread.updated_at,
              }
            : workspace,
        ),
        threads: [
          normalizeThreadSummary(daemonEvent.thread),
          ...snapshot.threads.filter(
            (thread) => thread.id !== daemonEvent.thread.id,
          ),
        ],
      };
    case "thread-updated":
      return {
        ...snapshot,
        threads: upsertThread(
          snapshot.threads,
          normalizeThreadSummary(daemonEvent.thread),
        ),
      };
    case "workspace-updated":
      return {
        ...snapshot,
        workspaces: upsertWorkspace(snapshot.workspaces, daemonEvent.workspace),
      };
    case "interactive-request": {
      const request = normalizeInteractiveRequest(daemonEvent.request);
      if (!request) return snapshot;
      return {
        ...snapshot,
        interactive_requests: [
          request,
          ...snapshot.interactive_requests.filter(
            (pending) => pending.request_id !== request.request_id,
          ),
        ],
      };
    }
    case "preferences-updated":
      return {
        ...snapshot,
        preferences: daemonEvent.preferences,
      };
    case "extension-catalog-updated":
      return {
        ...snapshot,
        extensions: {
          ...snapshot.extensions,
          catalog: daemonEvent.catalog,
        },
      };
    case "extension-view-updated": {
      const sameView = (view: DaemonSnapshot["extensions"]["views"][number]) =>
        view.extension_id === daemonEvent.extension_id &&
        view.view_id === daemonEvent.view_id &&
        (view.scope?.kind ?? null) === (daemonEvent.scope?.kind ?? null) &&
        (view.scope?.id ?? null) === (daemonEvent.scope?.id ?? null);
      const views = snapshot.extensions.views.filter((view) => !sameView(view));
      if (daemonEvent.view) views.push(daemonEvent.view);
      return {
        ...snapshot,
        extensions: { ...snapshot.extensions, views },
      };
    }
    case "scheduled-task-created":
    case "scheduled-task-updated": {
      const task = normalizeScheduledTask(daemonEvent.task);
      if (!task) return snapshot;
      const tasks = snapshot.scheduled_tasks ?? [];
      return {
        ...snapshot,
        scheduled_tasks: [
          task,
          ...tasks.filter((existing) => existing.id !== task.id),
        ],
      };
    }
    case "scheduled-task-deleted":
      return {
        ...snapshot,
        scheduled_tasks: (snapshot.scheduled_tasks ?? []).filter(
          (task) => task.id !== daemonEvent.task_id,
        ),
      };
    case "scheduled-task-run-started":
    case "scheduled-task-run-updated": {
      const run = normalizeScheduledTaskRun(daemonEvent.run);
      if (!run || run.task_id !== daemonEvent.task_id) return snapshot;
      return {
        ...snapshot,
        scheduled_tasks: (snapshot.scheduled_tasks ?? []).map((task) =>
          task.id === daemonEvent.task_id ? { ...task, last_run: run } : task,
        ),
      };
    }
    case "service": {
      const notice = daemonEvent.notice;
      const notices = snapshot.service_notices ?? [];
      if (!notice || notices.some((existing) => existing.id === notice.id)) {
        return snapshot;
      }
      return {
        ...snapshot,
        service_notices: [...notices, notice].slice(-32),
      };
    }
    case "operational-condition-upserted": {
      const conditions = snapshot.operational_conditions ?? [];
      return {
        ...snapshot,
        operational_conditions: [
          daemonEvent.condition,
          ...conditions.filter(
            (condition) =>
              condition.workspace_id !== daemonEvent.condition.workspace_id ||
              condition.key !== daemonEvent.condition.key,
          ),
        ],
      };
    }
    case "operational-condition-cleared":
      return {
        ...snapshot,
        operational_conditions: (snapshot.operational_conditions ?? []).filter(
          (condition) =>
            condition.workspace_id !== event.workspace_id ||
            condition.key !== daemonEvent.key,
        ),
        service_notices: (snapshot.service_notices ?? []).filter(
          (notice) => notice.id !== daemonEvent.condition_id,
        ),
      };
    case "thread-token-usage-updated": {
      if (!event.thread_id) return snapshot;
      const usage = snapshot.thread_token_usage ?? {};
      if (usage[event.thread_id] === daemonEvent.usage) return snapshot;
      return {
        ...snapshot,
        thread_token_usage: {
          ...usage,
          [event.thread_id]: daemonEvent.usage,
        },
      };
    }
    default:
      return snapshot;
  }
}

/**
 * Keeps UI selection pinned to a valid restored workspace/thread when ids change
 * across daemon restarts or snapshot rehydration.
 */
export function reconcileSnapshotSelection(
  snapshot: DaemonSnapshot | null,
  selectedWorkspaceId: string | null,
  selectedThreadId: string | null,
  options: ReconcileSnapshotSelectionOptions = {},
): SnapshotSelection {
  if (!snapshot) {
    return { workspaceId: null, threadId: null };
  }

  // The overwhelmingly common path is an already-valid selection receiving a
  // snapshot update while a turn streams. Avoid allocating two Maps and a
  // filtered thread list just to return the ids React already holds.
  if (selectedWorkspaceId) {
    const selectedWorkspace = snapshot.workspaces.find(
      (workspace) => workspace.id === selectedWorkspaceId,
    );
    if (selectedWorkspace) {
      if (
        selectedThreadId === null &&
        options.preserveEmptyThreadSelection === true
      ) {
        return { workspaceId: selectedWorkspaceId, threadId: null };
      }
      if (selectedThreadId) {
        const selectedThread = snapshot.threads.find(
          (thread) => thread.id === selectedThreadId,
        );
        if (selectedThread?.workspace_id === selectedWorkspaceId) {
          return {
            workspaceId: selectedWorkspaceId,
            threadId: selectedThreadId,
          };
        }
      }
    }
  }

  const workspaceById = new Map(
    snapshot.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const threadById = new Map(
    snapshot.threads.map((thread) => [thread.id, thread] as const),
  );

  let workspaceId =
    selectedWorkspaceId && workspaceById.has(selectedWorkspaceId)
      ? selectedWorkspaceId
      : null;
  let threadId =
    selectedThreadId && threadById.has(selectedThreadId)
      ? selectedThreadId
      : null;

  if (threadId) {
    workspaceId = threadById.get(threadId)?.workspace_id ?? workspaceId;
  }

  if (!workspaceId) {
    workspaceId =
      [...snapshot.workspaces]
        // Plain code-unit comparison (descending): updated_at is ISO-8601.
        .sort((left, right) =>
          right.updated_at < left.updated_at
            ? -1
            : right.updated_at > left.updated_at
              ? 1
              : 0,
        )[0]?.id ??
      snapshot.threads[0]?.workspace_id ??
      snapshot.workspaces[0]?.id ??
      null;
  }

  const workspace = workspaceId
    ? (workspaceById.get(workspaceId) ?? null)
    : null;
  const workspaceThreads = workspace
    ? snapshot.threads.filter((thread) => thread.workspace_id === workspace.id)
    : [];

  const shouldPreserveEmptyThreadSelection =
    options.preserveEmptyThreadSelection === true &&
    selectedThreadId === null &&
    selectedWorkspaceId !== null &&
    workspaceId === selectedWorkspaceId;

  if (
    !shouldPreserveEmptyThreadSelection &&
    (!threadId ||
      (workspace && threadById.get(threadId)?.workspace_id !== workspace.id))
  ) {
    const preferredThreadId =
      (workspace?.current_thread_id &&
      threadById.get(workspace.current_thread_id)?.workspace_id === workspace.id
        ? workspace.current_thread_id
        : null) ??
      workspaceThreads[0]?.id ??
      null;
    threadId = preferredThreadId;
  }

  return { workspaceId, threadId };
}

/**
 * Convert file inputs to ImageInput objects.
 * Shared by both desktop and remote-web apps.
 */
export async function filesToImageInputs(
  files: FileList | readonly File[] | null,
  existing: readonly ImageInput[] = [],
): Promise<ImageInput[]> {
  if (!files) return [];
  const selected = Array.from(files);
  const unsupported = selected.find((file) => !file.type?.startsWith("image/"));
  if (unsupported) {
    throw new Error(
      `Only image attachments are supported. ${unsupported.name || "That file"} was not attached.`,
    );
  }
  validateImageByteEntries([
    ...existing.flatMap((image) => {
      const bytes = imageInputByteSize(image);
      return bytes == null
        ? []
        : [{ name: image.name?.trim() || "Image", bytes }];
    }),
    ...selected.map((file) => ({
      name: file.name || "Image",
      bytes: file.size || 0,
    })),
  ]);
  const images = selected;
  return Promise.all(
    images.map(
      (file) =>
        new Promise<ImageInput>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () =>
            resolve({
              type: "image",
              id: crypto.randomUUID(),
              name: file.name,
              mime_type: file.type,
              url: String(reader.result),
              local_path: null,
            });
          reader.readAsDataURL(file);
        }),
    ),
  );
}
