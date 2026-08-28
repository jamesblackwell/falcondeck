import { describe, expect, it, vi } from "vitest";

import { forkThread, threadSupportsNativeFork } from "./fork-thread";
import type {
  ForkThreadPayload,
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

function makeAgent(model_id: string | null = null): ThreadSummary["agent"] {
  return {
    model_id,
    reasoning_effort: null,
    collaboration_mode_id: null,
    approval_policy: null,
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
    agents: [
      {
        provider: "codex",
        label: "Codex",
        account: { status: "ready", label: "signed in" },
        models: [],
        collaboration_modes: [],
        capabilities: {
          supports_review: true,
          supports_goals: true,
          supports_images: true,
          supports_skills: true,
          supports_interrupt: true,
          supports_steering: true,
          supports_forking: true,
          sandbox_modes: [],
          permission_modes: [],
        },
      },
      {
        provider: "claude",
        label: "Claude",
        account: { status: "ready", label: "signed in" },
        models: [],
        collaboration_modes: [],
        capabilities: {
          supports_review: false,
          supports_goals: true,
          supports_images: true,
          supports_skills: true,
          supports_interrupt: true,
          supports_steering: true,
          supports_forking: false,
          sandbox_modes: [],
          permission_modes: [],
        },
      },
    ],
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

function makeApi() {
  return {
    forkThread: vi.fn(
      async (_payload: ForkThreadPayload): Promise<ThreadHandle> => ({
        workspace: makeWorkspace(),
        thread: makeThread({ id: "thread-forked" }),
      }),
    ),
    startThread: vi.fn(
      async (_payload: StartThreadPayload): Promise<ThreadHandle> => ({
        workspace: makeWorkspace(),
        thread: makeThread({ id: "thread-handoff", latest_turn_id: null }),
      }),
    ),
    updateThread: vi.fn(
      async (payload: UpdateThreadPayload): Promise<ThreadHandle> => ({
        workspace: makeWorkspace(),
        thread: makeThread({
          id: payload.thread_id,
          title: payload.title ?? "Fix the login bug",
          latest_turn_id: null,
        }),
      }),
    ),
    sendTurn: vi.fn(async (_payload: SendTurnPayload) => ({
      ok: true as const,
    })),
    threadDetail: vi.fn(async (
      _workspaceId: string,
      _threadId: string,
      _request?: Omit<ThreadDetailRequest, "workspace_id" | "thread_id">,
    ): Promise<ThreadDetail> => ({
      workspace: makeWorkspace(),
      thread: makeThread(),
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
    })),
  };
}

describe("threadSupportsNativeFork", () => {
  it("is true only for the thread's own provider when it advertises supports_forking", () => {
    const workspace = makeWorkspace();
    expect(threadSupportsNativeFork(makeThread({ provider: "codex" }), workspace)).toBe(true);
    expect(threadSupportsNativeFork(makeThread({ provider: "claude" }), workspace)).toBe(false);
    expect(threadSupportsNativeFork(makeThread({ provider: "unknown" }), workspace)).toBe(false);
  });
});

describe("forkThread", () => {
  it("uses the native fork RPC when the provider supports it and a turn boundary exists", async () => {
    const api = makeApi();
    const workspace = makeWorkspace();
    const thread = makeThread({ provider: "codex", latest_turn_id: "turn-9" });

    const handle = await forkThread(api, { workspace, thread });

    expect(api.forkThread).toHaveBeenCalledWith({
      workspace_id: workspace.id,
      thread_id: thread.id,
      last_turn_id: "turn-9",
    });
    expect(api.threadDetail).not.toHaveBeenCalled();
    expect(api.startThread).not.toHaveBeenCalled();
    expect(handle.thread.id).toBe("thread-forked");
  });

  it("falls back to a same-provider handoff when the provider has no native fork", async () => {
    const api = makeApi();
    const workspace = makeWorkspace();
    const thread = makeThread({ provider: "claude", latest_turn_id: "turn-9" });

    await forkThread(api, { workspace, thread });

    expect(api.forkThread).not.toHaveBeenCalled();
    expect(api.threadDetail).toHaveBeenCalledWith(workspace.id, thread.id, {
      mode: "full",
    });
    expect(api.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: workspace.id,
        provider: "claude",
        isolation: "project_folder",
        handoff_from: { thread_id: thread.id, provider: "claude" },
      }),
    );
    // The seed turn is a transcript dump, not a user message, so the thread
    // must be titled before it — otherwise auto-title-derivation would name
    // it after the transcript-dump prompt instead of the source thread.
    expect(api.updateThread).toHaveBeenCalledWith({
      workspace_id: workspace.id,
      thread_id: "thread-handoff",
      title: "Fix the login bug (fork)",
    });
    expect(api.sendTurn).toHaveBeenCalledTimes(1);
    const sendTurnArgs = api.sendTurn.mock.calls[0]![0];
    expect(sendTurnArgs.workspace_id).toBe(workspace.id);
    expect(sendTurnArgs.thread_id).toBe("thread-handoff");
    expect(sendTurnArgs.inputs).toHaveLength(1);
    expect(sendTurnArgs.inputs[0]).toMatchObject({ type: "text" });
  });

  it("falls back to a same-provider handoff when the native provider has no completed turn yet", async () => {
    const api = makeApi();
    const workspace = makeWorkspace();
    const thread = makeThread({ provider: "codex", latest_turn_id: null });

    await forkThread(api, { workspace, thread });

    expect(api.forkThread).not.toHaveBeenCalled();
    expect(api.startThread).toHaveBeenCalledTimes(1);
  });

  it("refuses to fork an isolated (variant-backed) thread", async () => {
    const api = makeApi();
    const workspace = makeWorkspace();
    const thread = makeThread({
      variant: {
        slug: "fix-login",
        path: "/tmp/variants/fix-login",
        branch: "falcondeck/fix-login",
        kind: "worktree",
      },
    });

    await expect(forkThread(api, { workspace, thread })).rejects.toThrow(
      /isolated thread/,
    );
    expect(api.forkThread).not.toHaveBeenCalled();
    expect(api.startThread).not.toHaveBeenCalled();
  });

  it("refuses to fork a thread with no conversation yet", async () => {
    const api = makeApi();
    api.threadDetail.mockResolvedValueOnce({
      workspace: makeWorkspace(),
      thread: makeThread(),
      items: [],
      has_older: false,
      oldest_item_id: null,
      newest_item_id: null,
      is_partial: false,
    });
    const workspace = makeWorkspace();
    const thread = makeThread({ provider: "claude", latest_turn_id: null });

    await expect(forkThread(api, { workspace, thread })).rejects.toThrow(
      /Nothing to fork/,
    );
    expect(api.startThread).not.toHaveBeenCalled();
  });
});
