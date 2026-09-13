import { describe, expect, it, vi } from "vitest";

import {
  handoffBlockedReason,
  handoffDestinationSettings,
  handoffThread,
  pendingHandoffContextNotice,
  threadHasPendingHandoffContext,
} from "./handoff-thread";
import { NO_AGENT_CAPABILITIES } from "./collaboration";
import type { StartThreadPayload } from "./daemon-client";
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
  it("reads the source, then creates the destination with the transcript held for its first message", async () => {
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

    const handle = await handoffThread(api, baseArgs);

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
    // No turn is sent: the daemon holds the transcript and the user picks a
    // model and writes the first message themselves.
    const started = api.startThread.mock.calls[0]![0];
    expect(started.handoff_context).toContain("Where does auth happen?");
    expect(started.handoff_context).toContain("can still be resumed separately");
    expect(api.updateThread).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      thread_id: "thread-handoff",
      title: "Fix the login bug · Claude",
    });
    expect(handle.thread.id).toBe("thread-handoff");
  });

  it("pages back from the tail until the byte budget is met", async () => {
    const api = makeApi();
    const bulk = "x".repeat(60_000);
    const page = (ids: string[], oldest: string, hasOlder: boolean) => ({
      workspace: makeWorkspace(),
      thread: makeThread({ id: "thread-1" }),
      items: ids.map(
        (id) =>
          ({
            kind: "user_message",
            id,
            text: `${id} ${bulk}`,
            attachments: [],
            turn_id: null,
            previous_turn_id: null,
            created_at: "2026-01-01T00:00:00Z",
          }) as ThreadDetail["items"][number],
      ),
      has_older: hasOlder,
      oldest_item_id: oldest,
      newest_item_id: ids[ids.length - 1],
      is_partial: true,
    });
    const pages = [
      page(["c-1", "c-2"], "c-1", true),
      page(["b-1", "b-2"], "b-1", true),
      page(["a-1", "a-2"], "a-1", true),
      page(["z-1"], "z-1", true),
    ];
    let call = 0;
    api.threadDetail.mockImplementation(async () => pages[call++] ?? pages[0]);

    await handoffThread(api, { ...baseArgs, transcriptPageItems: 2 });

    // 2 items x 60KB per page: the budget is met after four pages, and the
    // walk stops rather than draining the whole thread.
    expect(api.threadDetail).toHaveBeenCalledTimes(4);
    expect(api.threadDetail).toHaveBeenNthCalledWith(1, "workspace-1", "thread-1", {
      mode: "tail",
      limit: 2,
    });
    expect(api.threadDetail).toHaveBeenNthCalledWith(2, "workspace-1", "thread-1", {
      mode: "before",
      before_item_id: "c-1",
      limit: 2,
    });
    const prompt = api.startThread.mock.calls[0]![0].handoff_context ?? "";
    // Oldest page read first, newest last, and the gap is disclosed.
    expect(prompt.indexOf("z-1")).toBeLessThan(prompt.indexOf("c-1"));
    expect(prompt).toContain("begins mid-conversation");
  });

  it("pages backwards from supplied seed items without a tail read", async () => {
    const api = makeApi();
    const seed = [
      {
        kind: "user_message",
        id: "seen-1",
        text: "Already on the device",
        attachments: [],
        turn_id: null,
        previous_turn_id: null,
        created_at: "2026-01-01T00:00:00Z",
      } as ThreadDetail["items"][number],
    ];
    api.threadDetail.mockImplementation(async () => ({
      workspace: makeWorkspace(),
      thread: makeThread({ id: "thread-1" }),
      items: [
        {
          kind: "user_message",
          id: "older-1",
          text: "x".repeat(500_000),
          attachments: [],
          turn_id: null,
          previous_turn_id: null,
          created_at: "2026-01-01T00:00:00Z",
        } as ThreadDetail["items"][number],
      ],
      has_older: true,
      oldest_item_id: "older-1",
      newest_item_id: "older-1",
      is_partial: true,
    }));

    await handoffThread(api, {
      ...baseArgs,
      transcriptPageItems: 20,
      seedItems: seed,
    });

    // No `tail`: it is the one read the daemon may widen past the limit.
    expect(api.threadDetail).toHaveBeenCalledTimes(1);
    expect(api.threadDetail).toHaveBeenCalledWith("workspace-1", "thread-1", {
      mode: "before",
      before_item_id: "seen-1",
      limit: 20,
    });
    const prompt = api.startThread.mock.calls[0]![0].handoff_context ?? "";
    expect(prompt).toContain("Already on the device");
    expect(prompt).toContain("begins mid-conversation");
  });

  it("stops paging when the source has no older history", async () => {
    const api = makeApi();
    api.threadDetail.mockImplementation(async (_workspaceId, threadId) => ({
      workspace: makeWorkspace(),
      thread: makeThread({ id: threadId }),
      items: [
        {
          kind: "user_message",
          id: "only-1",
          text: "Short thread",
          attachments: [],
          turn_id: null,
          previous_turn_id: null,
          created_at: "2026-01-01T00:00:00Z",
        } as ThreadDetail["items"][number],
      ],
      has_older: false,
      oldest_item_id: "only-1",
      newest_item_id: "only-1",
      is_partial: false,
    }));

    await handoffThread(api, { ...baseArgs, transcriptPageItems: 40 });

    expect(api.threadDetail).toHaveBeenCalledTimes(1);
    const prompt = api.startThread.mock.calls[0]![0].handoff_context ?? "";
    expect(prompt).not.toContain("begins mid-conversation");
  });

  it("reads the whole thread in one call when no page size is set", async () => {
    const api = makeApi();
    await handoffThread(api, baseArgs);
    expect(api.threadDetail).toHaveBeenCalledWith("workspace-1", "thread-1", {
      mode: "full",
    });
    const prompt = api.startThread.mock.calls[0]![0].handoff_context ?? "";
    expect(prompt).not.toContain("begins mid-conversation");
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
    const handle = await handoffThread(api, baseArgs);
    expect(handle.thread.id).toBe("thread-handoff");
    expect(api.startThread).toHaveBeenCalledTimes(1);
  });
});

describe("pending handoff context", () => {
  it("is only reported while the daemon still holds the transcript", () => {
    expect(threadHasPendingHandoffContext(null)).toBe(false);
    expect(threadHasPendingHandoffContext(makeThread())).toBe(false);
    expect(
      threadHasPendingHandoffContext(
        makeThread({
          handoff_from: { thread_id: "thread-1", provider: "codex" },
        }),
      ),
    ).toBe(false);
    const pending = makeThread({
      handoff_from: {
        thread_id: "thread-1",
        provider: "codex",
        context_pending: true,
      },
    });
    expect(threadHasPendingHandoffContext(pending)).toBe(true);
    expect(pendingHandoffContextNotice(pending, "Fix the login bug")).toBe(
      'The conversation from "Fix the login bug" is sent with your first message.',
    );
    expect(pendingHandoffContextNotice(pending, null)).toBe(
      "The previous conversation is sent with your first message.",
    );
    expect(pendingHandoffContextNotice(makeThread(), "x")).toBeNull();
  });
});
