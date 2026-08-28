import { describe, expect, it, vi } from "vitest";

import {
  HandoffIncompleteError,
  handoffBlockedReason,
  handoffDestinationSettings,
  handoffThread,
} from "./handoff-thread";
import { NO_AGENT_CAPABILITIES } from "./collaboration";
import type {
  SendTurnPayload,
  StartThreadPayload,
} from "./daemon-client";
import type {
  ThreadDetail,
  ThreadDetailRequest,
  ThreadHandle,
  ThreadSummary,
  UpdateThreadPayload,
  WorkspaceSummary,
} from "./types";

function makeAgent(model_id: string | null = "gpt-5"): ThreadSummary["agent"] {
  return {
    model_id,
    reasoning_effort: "medium",
    collaboration_mode_id: null,
    approval_policy: "never",
    service_tier: null,
    permission_mode: null,
    sandbox_mode: null,
  };
}

function makeWorkspace(
  overrides: Partial<WorkspaceSummary> = {},
): WorkspaceSummary {
  return {
    id: "workspace-1",
    path: "/tmp/project",
    status: "ready",
    agents: [],
    models: [],
    collaboration_modes: [],
    account: { status: "ready", label: "signed in" },
    current_thread_id: null,
    connected_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    last_error: null,
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    workspace_id: "workspace-1",
    title: "Fix the login bug",
    provider: "codex",
    native_session_id: "native-1",
    provider_transport: null,
    handoff_from: null,
    origin: null,
    status: "idle",
    updated_at: "2026-08-20T00:00:00Z",
    last_message_preview: null,
    latest_turn_id: "turn-1",
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: makeAgent(),
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
    is_pinned_in_project: false,
    goal: null,
    queued_turns: [],
    variant: null,
    ...overrides,
  };
}

function makeHandle(overrides: Partial<ThreadSummary> = {}): ThreadHandle {
  return {
    workspace: makeWorkspace(),
    thread: makeThread({
      id: "thread-handoff",
      provider: "claude",
      latest_turn_id: null,
      ...overrides,
    }),
  };
}

function makeApi() {
  return {
    startThread: vi.fn(
      async (_payload: StartThreadPayload): Promise<ThreadHandle> =>
        makeHandle(),
    ),
    updateThread: vi.fn(
      async (payload: UpdateThreadPayload): Promise<ThreadHandle> =>
        makeHandle({
          id: payload.thread_id,
          title: payload.title ?? "Fix the login bug · Claude",
        }),
    ),
    sendTurn: vi.fn(async (_payload: SendTurnPayload) => ({
      ok: true as const,
    })),
    threadDetail: vi.fn(
      async (
        _workspaceId: string,
        threadId: string,
        _request?: Omit<ThreadDetailRequest, "workspace_id" | "thread_id">,
      ): Promise<ThreadDetail> => ({
        workspace: makeWorkspace(),
        thread: makeThread({ id: threadId }),
        items: [
          {
            kind: "user_message",
            id: "user-1",
            text: "Where does auth happen?",
            attachments: [],
            turn_id: null,
            previous_turn_id: null,
            created_at: "2026-08-20T00:00:00Z",
          },
        ],
        has_older: false,
        oldest_item_id: null,
        newest_item_id: null,
        is_partial: false,
      }),
    ),
  };
}

const baseArgs = {
  workspace: makeWorkspace(),
  thread: makeThread(),
  provider: "claude",
  destinationLabel: "Claude",
  modelId: "claude-opus",
  permissionMode: null as string | null,
  sandboxMode: null as string | null,
  approvalPolicy: "on-request",
};

describe("handoffBlockedReason", () => {
  it("is silent for idle, running, waiting, and isolated threads", () => {
    expect(handoffBlockedReason(makeThread())).toBeNull();
    expect(handoffBlockedReason(makeThread({ status: "running" }))).toBeNull();
    expect(
      handoffBlockedReason(makeThread({ status: "waiting_for_input" })),
    ).toBeNull();
    expect(
      handoffBlockedReason(
        makeThread({
          variant: {
            slug: "fix-login",
            path: "/tmp/project/.falcondeck/fix-login",
            branch: "fix-login",
            kind: "worktree",
          },
        }),
      ),
    ).toBeNull();
  });

  it("names an in-flight handoff so the control stays visible", () => {
    expect(handoffBlockedReason(makeThread(), { pending: true })).toBe(
      "Creating the linked handoff thread…",
    );
  });
});

describe("handoffDestinationSettings", () => {
  it("uses the remembered model and advertised defaults for the destination", () => {
    const workspace = makeWorkspace({
      agents: [
        {
          provider: "claude",
          label: "Claude",
          account: { status: "ready", label: "signed in" },
          models: [
            {
              id: "claude-sonnet",
              label: "Sonnet",
              is_default: false,
              default_reasoning_effort: "medium",
              supported_reasoning_efforts: [],
            },
            {
              id: "claude-opus",
              label: "Opus",
              is_default: true,
              default_reasoning_effort: "high",
              supported_reasoning_efforts: [],
            },
          ],
          collaboration_modes: [],
          capabilities: {
            ...NO_AGENT_CAPABILITIES,
            permission_modes: ["default", "bypassPermissions"],
            sandbox_modes: ["workspace-write"],
          },
        },
      ],
    });

    expect(handoffDestinationSettings(workspace, "claude")).toEqual({
      destinationLabel: "Claude",
      modelId: "claude-opus",
      permissionMode: "bypassPermissions",
      sandboxMode: null,
      approvalPolicy: "on-request",
    });
    expect(
      handoffDestinationSettings(workspace, "claude", {
        "/tmp/project": {
          provider: "claude",
          selections: {
            claude: {
              modelId: "claude-sonnet",
              effort: null,
              permissionMode: "bypassPermissions",
              sandboxMode: "workspace-write",
              serviceTier: null,
            },
          },
        },
      }),
    ).toMatchObject({
      modelId: "claude-sonnet",
      permissionMode: "bypassPermissions",
      sandboxMode: "workspace-write",
    });
  });
});

describe("handoffThread", () => {
  it("reads the source before creating the destination, then seeds the turn", async () => {
    const api = makeApi();
    const order: string[] = [];
    api.threadDetail.mockImplementation(async () => {
      order.push("detail");
      return {
        workspace: makeWorkspace(),
        thread: makeThread(),
        items: [
          {
            kind: "user_message" as const,
            id: "user-1",
            text: "Where does auth happen?",
            attachments: [],
            turn_id: null,
            previous_turn_id: null,
            created_at: "2026-08-20T00:00:00Z",
          },
        ],
        has_older: false,
        oldest_item_id: null,
        newest_item_id: null,
        is_partial: false,
      };
    });
    api.startThread.mockImplementation(async () => {
      order.push("start");
      return makeHandle();
    });

    const onDestinationReady = vi.fn();
    const handle = await handoffThread(api, baseArgs, { onDestinationReady });

    expect(order).toEqual(["detail", "start"]);
    expect(api.threadDetail).toHaveBeenCalledWith(
      "workspace-1",
      "thread-1",
      { mode: "full" },
    );
    expect(api.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "workspace-1",
        provider: "claude",
        model_id: "claude-opus",
        isolation: "project_folder",
        handoff_from: { thread_id: "thread-1", provider: "codex" },
      }),
    );
    expect(api.updateThread).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      thread_id: "thread-handoff",
      title: "Fix the login bug · Claude",
    });
    expect(onDestinationReady).toHaveBeenCalledWith(handle);
    expect(api.sendTurn).toHaveBeenCalledTimes(1);
    const send = api.sendTurn.mock.calls[0]![0];
    expect(send.thread_id).toBe("thread-handoff");
    expect(send.provider).toBe("claude");
    expect(send.inputs).toHaveLength(1);
    expect(send.inputs[0]).toMatchObject({ type: "text" });
    expect(String((send.inputs[0] as { text: string }).text)).toContain(
      "Where does auth happen?",
    );
    expect(String((send.inputs[0] as { text: string }).text)).toContain(
      "can still be resumed separately",
    );
  });

  it("refuses a same-provider handoff and does not create a thread", async () => {
    const api = makeApi();
    await expect(
      handoffThread(api, { ...baseArgs, provider: "codex" }),
    ).rejects.toThrow("Choose a different agent to continue with.");
    expect(api.threadDetail).not.toHaveBeenCalled();
    expect(api.startThread).not.toHaveBeenCalled();
  });

  it("snapshots a running or isolated source instead of refusing", async () => {
    const api = makeApi();
    await handoffThread(api, {
      ...baseArgs,
      thread: makeThread({
        status: "running",
        variant: {
          slug: "fix-login",
          path: "/tmp/project/.falcondeck/fix-login",
          branch: "fix-login",
          kind: "worktree",
        },
      }),
    });
    expect(api.startThread).toHaveBeenCalledTimes(1);
  });

  it("does not create a destination when the source transcript cannot load", async () => {
    const api = makeApi();
    api.threadDetail.mockRejectedValue(new Error("source unavailable"));
    await expect(handoffThread(api, baseArgs)).rejects.toThrow(
      "source unavailable",
    );
    expect(api.startThread).not.toHaveBeenCalled();
  });

  it("still hands off when the destination rename fails", async () => {
    const api = makeApi();
    api.updateThread.mockRejectedValue(new Error("rename failed"));
    const onDestinationReady = vi.fn();
    const handle = await handoffThread(api, baseArgs, { onDestinationReady });
    expect(handle.thread.id).toBe("thread-handoff");
    expect(onDestinationReady).toHaveBeenCalledTimes(1);
    expect(api.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("reports a created destination when the seed turn fails to start", async () => {
    const api = makeApi();
    api.sendTurn.mockRejectedValue(new Error("turn.start failed"));
    api.threadDetail.mockImplementation(
      async (_workspaceId: string, threadId: string) => ({
        workspace: makeWorkspace(),
        thread: makeThread({
          id: threadId,
          status: threadId === "thread-handoff" ? "idle" : "idle",
        }),
        items:
          threadId === "thread-handoff"
            ? []
            : [
                {
                  kind: "user_message" as const,
                  id: "user-1",
                  text: "Where does auth happen?",
                  attachments: [],
                  turn_id: null,
                  previous_turn_id: null,
                  created_at: "2026-08-20T00:00:00Z",
                },
              ],
        has_older: false,
        oldest_item_id: null,
        newest_item_id: null,
        is_partial: false,
      }),
    );

    try {
      await handoffThread(api, baseArgs);
      throw new Error("expected HandoffIncompleteError");
    } catch (error) {
      expect(error).toBeInstanceOf(HandoffIncompleteError);
      const incomplete = error as HandoffIncompleteError;
      expect(incomplete.turnStarted).toBe(false);
      expect(incomplete.handle.thread.id).toBe("thread-handoff");
      expect(incomplete.prompt).toContain("Where does auth happen?");
      expect(incomplete.detail?.items).toEqual([]);
    }
  });

  it("treats a destination that already has items as a started turn", async () => {
    const api = makeApi();
    api.sendTurn.mockRejectedValue(new Error("lost confirmation"));
    try {
      await handoffThread(api, baseArgs);
      throw new Error("expected HandoffIncompleteError");
    } catch (error) {
      expect(error).toBeInstanceOf(HandoffIncompleteError);
      expect((error as HandoffIncompleteError).turnStarted).toBe(true);
    }
  });
});
