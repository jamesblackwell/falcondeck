import {
  collectActivityEntries,
  collectRecentEntries,
  type InteractiveRequest,
  type InteractiveResponsePayload,
  type ProjectGroup,
} from "@falcondeck/client-core";

/* ================================================================
   Activity window bridge.

   The popped-out Activity window is a display of the main window's
   state, not a second client. It opens no daemon connection and no
   relay sessions of its own — a second HostManager would enroll a
   duplicate device against every remote host — so the main window
   pushes a projection of what Activity renders, and the window sends
   actions back for the main window to perform with its own handlers.
   ================================================================ */

export const ACTIVITY_WINDOW_LABEL = "activity";

export const ACTIVITY_WINDOW_EVENTS = {
  /** Window → main: mounted, or re-mounted after a reload; send state. */
  ready: "falcondeck://activity-ready",
  /** Main → window: the current projection. */
  state: "falcondeck://activity-state",
  /** Window → main: going away; stop pushing state. */
  closed: "falcondeck://activity-closed",
  /** Window → main: raise the main window on this thread. */
  openThread: "falcondeck://activity-open-thread",
  /** Window → main: start a thread in the selected workspace. */
  newThread: "falcondeck://activity-new-thread",
  /** Window → main: clear a thread's unread state. */
  markRead: "falcondeck://activity-mark-read",
  /** Window → main: answer an approval or question. */
  respond: "falcondeck://activity-respond",
  /** Main → window: the outcome of one `respond`, by correlation id. */
  respondResult: "falcondeck://activity-respond-result",
} as const;

export type ActivityWindowState = {
  groups: ProjectGroup[];
  interactiveRequests: InteractiveRequest[];
  workspaceHosts: Record<string, { name: string; connected: boolean }>;
  canStartThread: boolean;
};

export type ActivityThreadRef = { workspaceId: string; threadId: string };

export type ActivityRespondMessage = {
  /** Correlates the reply, so the card can surface its own failure. */
  callId: string;
  request: InteractiveRequest;
  response: InteractiveResponsePayload;
};

export type ActivityRespondResult = {
  callId: string;
  error?: string;
};

/**
 * Narrow the snapshot to what Activity actually renders.
 *
 * A full snapshot is every thread in every project; Activity shows only the
 * handful in an actionable state, plus the few that just finished. Filtering
 * by the same collectors the view uses keeps the projection identical to
 * rendering from the whole snapshot, rather than merely close to it.
 */
export function projectActivityWindowState(
  groups: ProjectGroup[],
  interactiveRequests: InteractiveRequest[],
  workspaceHosts: Record<string, { name: string; connected: boolean }>,
  canStartThread: boolean,
  nowMs: number,
): ActivityWindowState {
  // The queue plus the trail behind it — the window derives both from the
  // threads it is given, so it has to receive the threads for both.
  const visible = new Set([
    ...collectActivityEntries(groups, interactiveRequests).map(
      (entry) => `${entry.workspaceId}:${entry.thread.id}`,
    ),
    ...collectRecentEntries(groups, interactiveRequests, { nowMs }).map(
      (entry) => `${entry.workspaceId}:${entry.thread.id}`,
    ),
  ]);

  const projectedGroups: ProjectGroup[] = [];
  const workspaceIds = new Set<string>();
  for (const group of groups) {
    const threads = group.threads.filter((thread) =>
      visible.has(`${group.workspace.id}:${thread.id}`),
    );
    if (threads.length === 0) continue;
    projectedGroups.push({ workspace: group.workspace, threads });
    workspaceIds.add(group.workspace.id);
  }

  const hosts: ActivityWindowState["workspaceHosts"] = {};
  for (const workspaceId of workspaceIds) {
    const host = workspaceHosts[workspaceId];
    if (host) hosts[workspaceId] = host;
  }

  return {
    groups: projectedGroups,
    interactiveRequests: interactiveRequests.filter(
      (request) =>
        !request.thread_id ||
        visible.has(`${request.workspace_id}:${request.thread_id}`),
    ),
    workspaceHosts: hosts,
    canStartThread,
  };
}

/**
 * Whether a projection differs from the last one sent. Snapshot events fire
 * far more often than Activity changes — token deltas, tool output, threads
 * the queue never shows — and each push crosses a process boundary.
 */
export function activityStateChanged(
  previous: ActivityWindowState | null,
  next: ActivityWindowState,
) {
  return !previous || JSON.stringify(previous) !== JSON.stringify(next);
}
