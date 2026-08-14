import { describe, expect, it } from "vitest";

import type {
  InteractiveRequest,
  ProjectGroup,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";

import {
  activityStateChanged,
  projectActivityWindowState,
} from "./activity-window-bridge";

function workspace(id: string): WorkspaceSummary {
  return {
    id,
    path: `/projects/${id}`,
    status: "ready",
    agents: [],
    default_provider: "codex",
    models: [],
    collaboration_modes: [],
    account: { status: "ready", label: "Ready" },
    current_thread_id: null,
    connected_at: "2026-08-13T09:00:00Z",
    updated_at: "2026-08-13T09:00:00Z",
    last_error: null,
  } as unknown as WorkspaceSummary;
}

function thread(
  workspaceId: string,
  overrides: Partial<ThreadSummary> & Pick<ThreadSummary, "id">,
): ThreadSummary {
  return {
    workspace_id: workspaceId,
    title: overrides.id,
    provider: "codex",
    status: "idle",
    updated_at: "2026-08-13T09:00:00Z",
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: {},
    attention: {
      level: "none",
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    is_archived: false,
    is_pinned: false,
    goal: null,
    queued_turns: [],
    variant: null,
    ...overrides,
  } as unknown as ThreadSummary;
}

const unread = {
  level: "unread",
  badge_label: null,
  unread: true,
  pending_approval_count: 0,
  pending_question_count: 0,
  last_agent_activity_seq: 2,
  last_read_seq: 1,
} as ThreadSummary["attention"];

function request(
  overrides: Partial<InteractiveRequest> &
    Pick<InteractiveRequest, "request_id" | "workspace_id" | "thread_id">,
): InteractiveRequest {
  return {
    method: "command",
    kind: "approval",
    approval_decisions: ["allow", "deny"],
    title: "Run tests?",
    detail: null,
    command: "npm test",
    path: "/projects/a",
    turn_id: null,
    item_id: null,
    questions: [],
    created_at: "2026-08-13T09:00:00Z",
    ...overrides,
  } as unknown as InteractiveRequest;
}

const hosts = {
  "ws-a": { name: "studio-mac", connected: true },
  "ws-b": { name: "ops-2", connected: false },
};

function groups(): ProjectGroup[] {
  return [
    {
      workspace: workspace("ws-a"),
      threads: [
        thread("ws-a", { id: "quiet" }),
        thread("ws-a", { id: "ready", attention: unread }),
      ],
    },
    {
      workspace: workspace("ws-b"),
      threads: [thread("ws-b", { id: "also-quiet" })],
    },
  ];
}

describe("projectActivityWindowState", () => {
  it("keeps only the threads Activity renders, and their hosts", () => {
    const state = projectActivityWindowState(groups(), [], hosts, true);

    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]!.workspace.id).toBe("ws-a");
    expect(state.groups[0]!.threads.map((entry) => entry.id)).toEqual([
      "ready",
    ]);
    // ws-b dropped out entirely, so shipping its host badge would be dead weight.
    expect(state.workspaceHosts).toEqual({ "ws-a": hosts["ws-a"] });
    expect(state.canStartThread).toBe(true);
  });

  it("carries the requests that put a thread in the queue", () => {
    const pending = request({
      request_id: "req-1",
      workspace_id: "ws-b",
      thread_id: "also-quiet",
    });
    const state = projectActivityWindowState(groups(), [pending], hosts, false);

    expect(state.groups.map((group) => group.workspace.id)).toEqual([
      "ws-a",
      "ws-b",
    ]);
    expect(state.interactiveRequests).toEqual([pending]);
    expect(state.workspaceHosts).toEqual(hosts);
  });

  it("drops requests whose thread is no longer in the queue", () => {
    const stale = request({
      request_id: "req-stale",
      workspace_id: "ws-a",
      thread_id: "archived-elsewhere",
    });
    const state = projectActivityWindowState(groups(), [stale], hosts, false);

    expect(state.interactiveRequests).toEqual([]);
  });

  it("returns an empty projection when nothing needs attention", () => {
    const quiet: ProjectGroup[] = [
      { workspace: workspace("ws-a"), threads: [thread("ws-a", { id: "q" })] },
    ];
    expect(projectActivityWindowState(quiet, [], hosts, true)).toEqual({
      groups: [],
      interactiveRequests: [],
      workspaceHosts: {},
      canStartThread: true,
      composerWorkspaces: [quiet[0]!.workspace],
      selectedWorkspaceId: null,
    });
  });
});

describe("activityStateChanged", () => {
  const base = projectActivityWindowState(groups(), [], hosts, true);

  it("treats the first projection as a change", () => {
    expect(activityStateChanged(null, base)).toBe(true);
  });

  it("ignores snapshot churn that Activity would render identically", () => {
    const noisy = groups();
    noisy[0]!.threads[0] = thread("ws-a", {
      id: "quiet",
      last_message_preview: "streaming tokens the queue never shows",
    });
    const next = projectActivityWindowState(noisy, [], hosts, true);

    expect(activityStateChanged(base, next)).toBe(false);
  });

  it("reports a change when a thread enters the queue", () => {
    const busy = groups();
    busy[1]!.threads[0] = thread("ws-b", {
      id: "also-quiet",
      attention: unread,
    });
    const next = projectActivityWindowState(busy, [], hosts, true);

    expect(activityStateChanged(base, next)).toBe(true);
  });
});
