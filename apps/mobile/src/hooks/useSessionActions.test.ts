import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import * as Haptics from "expo-haptics";

import { useRelayStore } from "@/store/relay-store";
import { useSessionStore } from "@/store/session-store";
import { useUIStore } from "@/store/ui-store";
import { useSessionActions } from "./useSessionActions";
import { draftKeyFor } from "@falcondeck/client-core";

import {
  assistantMessage,
  snapshot,
  snapshotEvent,
  thread,
  threadDetail,
  userMessage,
  workspace,
} from "../test/factories";

type RelayStoreState = ReturnType<typeof useRelayStore.getState>;
const originalConsoleError = console.error;

function resetAll() {
  useSessionStore.getState().reset();
  useRelayStore.setState({
    relayUrl: "https://relay.test",
    pairingCode: "",
    sessionId: null,
    deviceId: null,
    connectionStatus: "not_connected",
    machinePresence: null,
    error: null,
    isConnected: false,
    isEncrypted: false,
  });
  useUIStore.setState({
    conversationKey: "none:new",
    drafts: {},
    attachmentsByConversation: {},
    draft: "",
    attachments: [],
    selectedProvider: null,
    selectedModel: null,
    selectedEffort: "medium",
    pendingSubmissions: {},
    pendingNewThreadItem: null,
    isSubmitting: false,
  });
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, "error").mockImplementation((message, ...args) => {
    if (
      typeof message === "string" &&
      (message.includes("react-test-renderer is deprecated") ||
        message.includes(
          "The current testing environment is not configured to support act",
        ))
    ) {
      return;
    }
    originalConsoleError(message, ...args);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

function mountSessionActions() {
  let actions: ReturnType<typeof useSessionActions> | null = null;
  let renderer: TestRenderer.ReactTestRenderer | null = null;

  function Harness() {
    actions = useSessionActions();
    return null;
  }

  act(() => {
    renderer = TestRenderer.create(React.createElement(Harness));
  });

  return {
    getActions() {
      if (!actions) {
        throw new Error("Session actions hook did not mount");
      }
      return actions;
    },
    unmount() {
      if (!renderer) return;
      act(() => {
        renderer?.unmount();
      });
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function imageAgent(provider: string, supportsImages: boolean) {
  return {
    provider,
    label: provider.toUpperCase(),
    account: { status: "ready" as const, label: "ready" },
    models: [],
    collaboration_modes: [],
    capabilities: {
      supports_review: false,
      supports_goals: false,
      supports_images: supportsImages,
      supports_skills: false,
      supports_interrupt: true,
      supports_steering: false,
      supports_forking: false,
      supports_compaction: false,
      supports_compaction_instructions: false,
      sandbox_modes: [],
      permission_modes: [],
    },
  };
}

describe("submitTurn guards", () => {
  beforeEach(resetAll);

  it("requires a workspace to be selected", () => {
    // No snapshot loaded → no workspace
    const session = useSessionStore.getState();
    const workspace = session.snapshot?.workspaces.find(
      (w) => w.id === session.selectedWorkspaceId,
    );
    expect(workspace).toBeUndefined();
  });

  it("requires non-empty draft", () => {
    const ui = useUIStore.getState();
    expect(ui.draft.trim()).toBe("");
  });

  it("requires a selected threadId", () => {
    const snap = snapshot();
    useSessionStore.getState().applyDaemonEvent({
      seq: 1,
      emitted_at: "2026-03-16T10:00:00Z",
      workspace_id: null,
      thread_id: null,
      event: { type: "snapshot", snapshot: snap },
    });
    useSessionStore.getState().selectWorkspace("workspace-1");
    // selectedThreadId should be set from current_thread_id or null
    const state = useSessionStore.getState();
    // Default workspace has current_thread_id: null, so thread is null
    expect(state.selectedThreadId).toBeNull();
  });

  it("all guards pass when workspace, thread, and draft are set", () => {
    const snap = snapshot({
      workspaces: [workspace({ id: "w1", current_thread_id: "t1" })],
      threads: [thread({ id: "t1", workspace_id: "w1" })],
    });
    useSessionStore.getState().applyDaemonEvent({
      seq: 1,
      emitted_at: "2026-03-16T10:00:00Z",
      workspace_id: null,
      thread_id: null,
      event: { type: "snapshot", snapshot: snap },
    });
    useSessionStore.getState().selectWorkspace("w1");
    useUIStore.getState().setDraft("Hello world");

    const session = useSessionStore.getState();
    const ui = useUIStore.getState();
    const ws = session.snapshot?.workspaces.find(
      (w) => w.id === session.selectedWorkspaceId,
    );

    expect(ws).toBeDefined();
    expect(ws!.id).toBe("w1");
    expect(session.selectedThreadId).toBe("t1");
    expect(ui.draft.trim()).toBe("Hello world");
  });

  it("coalesces repeated suggestion taps while the first turn is pending", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [workspace({ id: "w1", current_thread_id: "t1" })],
          threads: [thread({ id: "t1", workspace_id: "w1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");
    const pendingRpc = createDeferred<unknown>();
    const rpc = vi.fn().mockReturnValue(pendingRpc.promise);
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      const first = harness.getActions().submitTurn({ text: "Run the suggestion" });
      const second = harness.getActions().submitTurn({ text: "Run the suggestion" });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(rpc).toHaveBeenCalledTimes(1);
      pendingRpc.resolve({ ok: true });
      await act(async () => {
        await Promise.all([first, second]);
      });
    } finally {
      harness.unmount();
    }
  });

  it("routes /compact as a thread control without starting a model turn", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [workspace({ id: "w1", current_thread_id: "t1" })],
          threads: [thread({ id: "t1", workspace_id: "w1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");
    useUIStore.getState().setDraft("/compact preserve protocol decisions");
    const rpc = vi.fn().mockResolvedValue({ ok: true });
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().submitTurn();
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).toHaveBeenCalledWith(
      "thread.compact",
      {
        workspace_id: "w1",
        thread_id: "t1",
        instructions: "preserve protocol decisions",
      },
      { requestIdPrefix: "mobile-compact" },
    );
    expect(rpc.mock.calls.some(([method]) => method === "turn.start")).toBe(
      false,
    );
    expect(useUIStore.getState().draft).toBe("");
  });

  it("allows attachments without draft text", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({
              id: "w1",
              current_thread_id: "t1",
              agents: [imageAgent("codex", true)],
            }),
          ],
          threads: [thread({ id: "t1", workspace_id: "w1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");
    useUIStore.getState().setAttachments([
      {
        type: "image",
        id: "img-1",
        name: "diagram.png",
        mime_type: "image/png",
        url: "data:image/png;base64,abc",
      },
    ]);

    const rpc = vi.fn().mockResolvedValue(undefined);
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().submitTurn();
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).toHaveBeenCalledWith(
      "turn.start",
      expect.objectContaining({
        inputs: [
          {
            type: "image",
            id: "img-1",
            name: "diagram.png",
            mime_type: "image/png",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
      { requestIdPrefix: "mobile-turn" },
    );
  });

  it("keeps images in the composer when the authoritative thread provider rejects them", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({
              id: "w1",
              current_thread_id: "t1",
              default_provider: "codex",
              agents: [
                imageAgent("codex", true),
                imageAgent("text-agent", false),
              ],
            }),
          ],
          threads: [
            thread({ id: "t1", workspace_id: "w1", provider: "text-agent" }),
          ],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");
    useUIStore.setState({
      draft: "Inspect this",
      selectedProvider: "codex",
    });
    useUIStore.getState().setAttachments([
      {
        type: "image",
        id: "img-unsupported",
        name: "diagram.png",
        mime_type: "image/png",
        url: "data:image/png;base64,abc",
      },
    ]);

    const rpc = vi.fn();
    const setError = vi.fn();
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().submitTurn();
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(
      "The selected agent does not support image attachments. Remove the image or choose an agent that supports images.",
    );
    expect(useUIStore.getState().draft).toBe("Inspect this");
    expect(useUIStore.getState().attachments).toHaveLength(1);
    expect(useUIStore.getState().isSubmitting).toBe(false);
  });

  it("states the advertised tier on turns when fast mode is on", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({
              id: "w1",
              current_thread_id: "t1",
              agents: [
                {
                  provider: "codex",
                  label: "Codex",
                  account: { status: "ready", label: "ready" },
                  models: [
                    {
                      id: "gpt-5.6-sol",
                      label: "GPT-5.6-Sol",
                      is_default: true,
                      default_reasoning_effort: "medium",
                      supported_reasoning_efforts: [],
                      service_tiers: [
                        {
                          id: "priority",
                          name: "Fast",
                          description: "1.5x speed",
                        },
                      ],
                      default_service_tier: null,
                    },
                  ],
                  collaboration_modes: [],
                },
              ],
            }),
          ],
          threads: [thread({ id: "t1", workspace_id: "w1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");
    useUIStore.setState({
      draft: "Quick one",
      selectedProvider: "codex",
      selectedModel: "gpt-5.6-sol",
      selectedServiceTier: "priority",
      isSubmitting: false,
    });

    const rpc = vi.fn().mockResolvedValue({});
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().submitTurn();
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).toHaveBeenCalledWith(
      "turn.start",
      expect.objectContaining({ service_tier: "priority" }),
      { requestIdPrefix: "mobile-turn" },
    );
  });

  it("submits selected skills and restores attachments on failure", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({
              id: "w1",
              current_thread_id: "t1",
              skills: [
                {
                  id: "skill-1",
                  label: "Lint",
                  alias: "/lint",
                  availability: "both",
                  providers: ["codex", "claude"],
                  source_kind: "project_file",
                  description: "Run lint fixes",
                },
              ],
            }),
          ],
          threads: [thread({ id: "t1", workspace_id: "w1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");
    useUIStore.setState({
      draft: "Please use /lint on this file",
      attachments: [
        {
          type: "image",
          id: "img-1",
          name: "error.png",
          mime_type: "image/png",
          url: "data:image/png;base64,abc",
        },
      ],
      selectedProvider: "codex",
      selectedModel: "gpt-5",
      selectedEffort: "high",
      isSubmitting: false,
    });

    const rpc = vi.fn().mockRejectedValue(new Error("nope"));
    const setError = vi.fn();
    const notificationAsync = vi.spyOn(Haptics, "notificationAsync");
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().submitTurn();
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).toHaveBeenCalledWith(
      "turn.start",
      {
        workspace_id: "w1",
        thread_id: "t1",
        inputs: [
          { type: "text", text: "Please use /lint on this file" },
          {
            type: "image",
            id: "img-1",
            name: "error.png",
            mime_type: "image/png",
            url: "data:image/png;base64,abc",
          },
        ],
        user_item_id: expect.stringMatching(/^user-[0-9a-f]{32}$/),
        selected_skills: [{ skill_id: "skill-1", alias: "/lint" }],
        provider: "codex",
        model_id: "gpt-5",
        reasoning_effort: "high",
        // No permission mode selected maps to codex "never", matching the
        // desktop composer (approvalPolicyForProvider).
        approval_policy: "never",
        service_tier: null,
        permission_mode: null,
        sandbox_mode: null,
        resume_interrupted: false,
      },
      { requestIdPrefix: "mobile-turn" },
    );
    expect(useUIStore.getState().draft).toBe("Please use /lint on this file");
    expect(useUIStore.getState().attachments).toEqual([
      {
        type: "image",
        id: "img-1",
        name: "error.png",
        mime_type: "image/png",
        url: "data:image/png;base64,abc",
      },
    ]);
    expect(setError).toHaveBeenCalledWith("nope");
    expect(notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Error,
    );
    notificationAsync.mockRestore();
  });

  it("merges input added while a pending send fails", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [workspace({ id: "w1", current_thread_id: "t1" })],
          threads: [thread({ id: "t1", workspace_id: "w1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");
    const failedImage = {
      type: "image" as const,
      id: "img-failed",
      name: "failed.png",
      mime_type: "image/png",
      url: "data:image/png;base64,failed",
    };
    const newerImage = {
      type: "image" as const,
      id: "img-newer",
      name: "newer.png",
      mime_type: "image/png",
      url: "data:image/png;base64,newer",
    };
    useUIStore.getState().setDraft("Failed message");
    useUIStore.getState().setAttachments([failedImage]);

    const pendingRpc = createDeferred<unknown>();
    useRelayStore.setState({
      _callRpc: vi
        .fn()
        .mockReturnValue(pendingRpc.promise) as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      const submission = harness.getActions().submitTurn();
      // The composer empties on the tap, not on the daemon's reply: the
      // transcript is already showing this message.
      expect(useUIStore.getState().draft).toBe("");
      expect(useUIStore.getState().attachments).toEqual([]);

      useUIStore.getState().setDraft("New draft");
      useUIStore.getState().setAttachments([newerImage]);
      // The send yields a paint before its RPC, so let those ticks pass
      // before failing it — rejecting earlier would race the call itself.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      pendingRpc.reject(new Error("offline"));
      await act(async () => submission);

      expect(useUIStore.getState().draft).toBe("Failed message\n\nNew draft");
      expect(useUIStore.getState().attachments).toEqual([
        failedImage,
        newerImage,
      ]);
    } finally {
      harness.unmount();
    }
  });

  it("starts and sends a new thread without reclaiming navigation made while it was pending", async () => {
    const existingThread = thread({ id: "t-existing", workspace_id: "w1" });
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({ id: "w1", current_thread_id: "t-existing" }),
          ],
          threads: [existingThread],
        }),
      ),
    );
    useSessionStore.getState().selectNewThread("w1");
    useUIStore.getState().setDraft("Start this in a new thread");

    const start = createDeferred<{
      workspace: ReturnType<typeof workspace>;
      thread: ReturnType<typeof thread>;
    }>();
    const rpc = vi
      .fn()
      .mockReturnValueOnce(start.promise)
      .mockResolvedValueOnce({ ok: true });
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      const submission = harness.getActions().submitTurn();
      expect(useUIStore.getState().pendingNewThreadItem).toMatchObject({
        conversationKey: "w1:new",
        item: {
          kind: "user_message",
          text: "Start this in a new thread",
          pending: true,
        },
      });
      useSessionStore.getState().selectThread("w1", "t-existing");
      useUIStore.getState().setDraft("Keep the existing thread draft");
      expect(useUIStore.getState().isSubmitting).toBe(false);

      start.resolve({
        workspace: workspace({ id: "w1", current_thread_id: "t-new" }),
        thread: thread({ id: "t-new", workspace_id: "w1" }),
      });
      await act(async () => submission);

      expect(useSessionStore.getState().selectedThreadId).toBe("t-existing");
      expect(useUIStore.getState().draft).toBe(
        "Keep the existing thread draft",
      );
      expect(useUIStore.getState().pendingNewThreadItem).toBeNull();
      expect(useSessionStore.getState().threadItems["t-new"]).toEqual([
        expect.objectContaining({
          kind: "user_message",
          text: "Start this in a new thread",
          pending: true,
        }),
      ]);
      expect(rpc).toHaveBeenNthCalledWith(
        2,
        "turn.start",
        expect.objectContaining({
          thread_id: "t-new",
          inputs: [{ type: "text", text: "Start this in a new thread" }],
        }),
        { requestIdPrefix: "mobile-turn" },
      );
    } finally {
      harness.unmount();
    }
  });

  it("empties the composer on send and keeps a recovery copy until the turn is accepted", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [workspace({ id: "w1", current_thread_id: "t1" })],
          threads: [thread({ id: "t1", workspace_id: "w1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");
    useUIStore.getState().setDraft("Ship it");

    const pendingRpc = createDeferred<unknown>();
    const notificationAsync = vi.spyOn(Haptics, "notificationAsync");
    useRelayStore.setState({
      _callRpc: vi
        .fn()
        .mockReturnValue(pendingRpc.promise) as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      const submission = harness.getActions().submitTurn();

      // Cleared for the reader, but not yet forgotten: a process death here
      // has to give the message back on the next launch.
      expect(useUIStore.getState().draft).toBe("");
      expect(useUIStore.getState().inFlightSubmissions["w1:t1"]?.text).toBe(
        "Ship it",
      );
      expect(notificationAsync).not.toHaveBeenCalled();

      pendingRpc.resolve({ ok: true });
      await act(async () => submission);

      expect(useUIStore.getState().draft).toBe("");
      expect(useUIStore.getState().inFlightSubmissions["w1:t1"]).toBeUndefined();
      expect(notificationAsync).toHaveBeenCalledWith(
        Haptics.NotificationFeedbackType.Success,
      );
    } finally {
      notificationAsync.mockRestore();
      harness.unmount();
    }
  });
});

describe("retryResponse", () => {
  beforeEach(resetAll);

  it("forks at the safe boundary and resends the exact original input", async () => {
    const sourceThread = thread({
      id: "t1",
      workspace_id: "w1",
      provider: "codex",
      agent: {
        model_id: "gpt-5",
        reasoning_effort: "high",
        collaboration_mode_id: null,
        approval_policy: "on-request",
        service_tier: "priority",
        permission_mode: "workspace-write",
        sandbox_mode: "workspace-write",
      },
    });
    const sourceWorkspace = workspace({ id: "w1", current_thread_id: "t1" });
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [sourceWorkspace],
          threads: [sourceThread],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");

    const branchWorkspace = workspace({ id: "w1", current_thread_id: "t2" });
    const branchThread = thread({
      id: "t2",
      workspace_id: "w1",
      provider: "codex",
    });
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        workspace: branchWorkspace,
        thread: branchThread,
      })
      .mockResolvedValueOnce({ ok: true });
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);
    const message = {
      kind: "user_message" as const,
      id: "user-2",
      text: "Retry this prompt",
      attachments: [
        {
          type: "image" as const,
          id: "image-1",
          name: "diagram.png",
          mime_type: "image/png",
          url: "data:image/png;base64,abc",
        },
      ],
      turn_id: "turn-2",
      previous_turn_id: "turn-1",
      created_at: "2026-08-09T12:00:00Z",
    };

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().retryResponse(message);
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "thread.fork",
      {
        workspace_id: "w1",
        thread_id: "t1",
        last_turn_id: "turn-1",
      },
      { requestIdPrefix: "mobile-fork" },
    );
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      "turn.start",
      expect.objectContaining({
        workspace_id: "w1",
        thread_id: "t2",
        inputs: [
          { type: "text", text: "Retry this prompt" },
          message.attachments[0],
        ],
        provider: "codex",
        model_id: "gpt-5",
        reasoning_effort: "high",
        service_tier: "priority",
      }),
      { requestIdPrefix: "mobile-retry-turn" },
    );
    expect(useSessionStore.getState().selectedThreadId).toBe("t2");
    expect(useUIStore.getState().isSubmitting).toBe(false);
  });

  it("continues a retry in its branch without hijacking a newer selection", async () => {
    const sourceThread = thread({ id: "t1", workspace_id: "w1" });
    const otherThread = thread({ id: "t-other", workspace_id: "w1" });
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [workspace({ id: "w1", current_thread_id: "t1" })],
          threads: [sourceThread, otherThread],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");

    const fork = createDeferred<{
      workspace: ReturnType<typeof workspace>;
      thread: ReturnType<typeof thread>;
    }>();
    const turn = createDeferred<unknown>();
    const rpc = vi
      .fn()
      .mockReturnValueOnce(fork.promise)
      .mockReturnValueOnce(turn.promise);
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);
    const message = {
      kind: "user_message" as const,
      id: "user-retry-race",
      text: "Retry in the background",
      attachments: [],
      turn_id: "turn-2",
      previous_turn_id: "turn-1",
      created_at: "2026-08-09T12:00:00Z",
    };

    const harness = mountSessionActions();
    try {
      const retry = harness.getActions().retryResponse(message);
      expect(useUIStore.getState().isSubmitting).toBe(true);
      useSessionStore.getState().selectThread("w1", "t-other");
      expect(useUIStore.getState().isSubmitting).toBe(false);

      fork.resolve({
        workspace: workspace({ id: "w1", current_thread_id: "t-branch" }),
        thread: thread({ id: "t-branch", workspace_id: "w1" }),
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(useSessionStore.getState().selectedThreadId).toBe("t-other");
      expect(useUIStore.getState().isSubmitting).toBe(false);
      expect(rpc).toHaveBeenNthCalledWith(
        2,
        "turn.start",
        expect.objectContaining({ thread_id: "t-branch" }),
        { requestIdPrefix: "mobile-retry-turn" },
      );

      turn.resolve({ ok: true });
      await act(async () => retry);
      expect(useSessionStore.getState().selectedThreadId).toBe("t-other");
      expect(useUIStore.getState().isSubmitting).toBe(false);
    } finally {
      harness.unmount();
    }
  });
});

describe("respondApproval", () => {
  beforeEach(resetAll);

  it("requires a workspace to be selected", () => {
    const session = useSessionStore.getState();
    const ws = session.snapshot?.workspaces.find(
      (w) => w.id === session.selectedWorkspaceId,
    );
    expect(ws).toBeUndefined();
  });

  it("workspace is available when snapshot is loaded and selected", () => {
    const snap = snapshot();
    useSessionStore.getState().applyDaemonEvent({
      seq: 1,
      emitted_at: "2026-03-16T10:00:00Z",
      workspace_id: null,
      thread_id: null,
      event: { type: "snapshot", snapshot: snap },
    });
    useSessionStore.getState().selectWorkspace("workspace-1");

    const session = useSessionStore.getState();
    const ws = session.snapshot?.workspaces.find(
      (w) => w.id === session.selectedWorkspaceId,
    );
    expect(ws).toBeDefined();
    expect(ws!.id).toBe("workspace-1");
  });
});

describe("respondInteractive", () => {
  beforeEach(resetAll);

  it("sends structured question answers through the generic interactive RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true });
    const setError = vi.fn();
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);
    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness
          .getActions()
          .respondInteractive("workspace-1", "question-1", {
            kind: "question",
            answers: { framework: ["React Native"], token: ["secret"] },
          });
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).toHaveBeenCalledWith(
      "interactive.respond",
      {
        workspace_id: "workspace-1",
        request_id: "question-1",
        response: {
          kind: "question",
          answers: { framework: ["React Native"], token: ["secret"] },
        },
      },
      { requestIdPrefix: "mobile-interactive" },
    );
    expect(setError).toHaveBeenCalledWith(null);
  });

  it("reports and rethrows failures so the pinned answer remains retryable", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("Relay disconnected"));
    const setError = vi.fn();
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);
    const harness = mountSessionActions();
    try {
      await expect(
        harness.getActions().respondInteractive("workspace-1", "question-1", {
          kind: "question",
          answers: { framework: ["React Native"] },
        }),
      ).rejects.toThrow("Relay disconnected");
    } finally {
      harness.unmount();
    }
    expect(setError).toHaveBeenCalledWith("Relay disconnected");
  });

  it("does not toast a dropped relay while reconnecting already explains it", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("Lost the relay connection"));
    const setError = vi.fn();
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);
    const harness = mountSessionActions();
    try {
      await expect(
        harness.getActions().respondInteractive("workspace-1", "question-1", {
          kind: "question",
          answers: { framework: ["React Native"] },
        }),
      ).rejects.toThrow("Lost the relay connection");
    } finally {
      harness.unmount();
    }
    expect(setError).not.toHaveBeenCalled();
  });
});

describe("_sendMessage", () => {
  beforeEach(resetAll);

  it("throws when socket is not open", () => {
    const relay = useRelayStore.getState();
    expect(() => {
      relay._sendMessage({ type: "ping" });
    }).toThrow("Not connected to the relay");
  });
});

describe("isSubmitting state management", () => {
  beforeEach(resetAll);

  it("tracks submission lifecycle", () => {
    const ui = useUIStore.getState();

    expect(useUIStore.getState().isSubmitting).toBe(false);

    ui.setIsSubmitting(true);
    expect(useUIStore.getState().isSubmitting).toBe(true);

    ui.setIsSubmitting(false);
    expect(useUIStore.getState().isSubmitting).toBe(false);
  });

  it("clearDraft resets draft text", () => {
    useUIStore.getState().setDraft("Some message");
    expect(useUIStore.getState().draft).toBe("Some message");

    useUIStore.getState().clearDraft();
    expect(useUIStore.getState().draft).toBe("");
  });
});

describe("loadThreadDetail", () => {
  beforeEach(resetAll);

  it("keeps a background thread refresh failure out of the global error banner", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({ id: "workspace-1", current_thread_id: "thread-1" }),
          ],
          threads: [thread({ id: "thread-1", workspace_id: "workspace-1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("workspace-1", "thread-1");

    const setError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useRelayStore.setState({
      _callRpc: vi
        .fn()
        .mockRejectedValue(
          new Error("Timed out waiting for thread.detail"),
        ) as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().loadThreadDetail("workspace-1", "thread-1");
      });

      expect(setError).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Failed to refresh thread detail",
        expect.objectContaining({
          message: "Timed out waiting for thread.detail",
        }),
      );
    } finally {
      harness.unmount();
      warn.mockRestore();
    }
  });

  it("requests the newest tail window for the selected thread", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({ id: "workspace-1", current_thread_id: "thread-1" }),
          ],
          threads: [thread({ id: "thread-1", workspace_id: "workspace-1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("workspace-1", "thread-1");

    const rpc = vi.fn().mockResolvedValue(
      threadDetail({
        items: [assistantMessage("msg-1", "hello")],
        has_older: false,
        oldest_item_id: "msg-1",
        newest_item_id: "msg-1",
        is_partial: true,
      }),
    );
    const setError = vi.fn();
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().loadThreadDetail("workspace-1", "thread-1");
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).toHaveBeenCalledWith(
      "thread.detail",
      {
        workspace_id: "workspace-1",
        thread_id: "thread-1",
        mode: "tail",
        limit: 150,
      },
      { requestIdPrefix: "mobile-detail" },
    );
    expect(
      useSessionStore.getState().threadDetail?.items.map((item) => item.id),
    ).toEqual(["msg-1"]);
    expect(setError).toHaveBeenCalledWith(null);
  });

  it("requests older history from the current cached oldest item and prepends it", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({ id: "workspace-1", current_thread_id: "thread-1" }),
          ],
          threads: [thread({ id: "thread-1", workspace_id: "workspace-1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("workspace-1", "thread-1");
    useSessionStore.getState().setThreadDetail(
      threadDetail({
        items: [
          assistantMessage("msg-2", "second"),
          assistantMessage("msg-3", "third"),
        ],
        has_older: true,
        oldest_item_id: "msg-2",
        newest_item_id: "msg-3",
        is_partial: true,
      }),
    );

    const rpc = vi.fn().mockResolvedValue(
      threadDetail({
        items: [
          assistantMessage("msg-0", "zero"),
          assistantMessage("msg-1", "one"),
        ],
        has_older: false,
        oldest_item_id: "msg-0",
        newest_item_id: "msg-1",
        is_partial: true,
      }),
    );
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness
          .getActions()
          .loadThreadDetail("workspace-1", "thread-1", { older: true });
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).toHaveBeenCalledWith(
      "thread.detail",
      {
        workspace_id: "workspace-1",
        thread_id: "thread-1",
        mode: "before",
        before_item_id: "msg-2",
        limit: 100,
      },
      { requestIdPrefix: "mobile-detail-older" },
    );
    expect(
      useSessionStore
        .getState()
        .threadItems["thread-1"]?.map((item) => item.id),
    ).toEqual(["msg-0", "msg-1", "msg-2", "msg-3"]);
  });

  it("shows a friendly error when user-requested older history fails", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({ id: "workspace-1", current_thread_id: "thread-1" }),
          ],
          threads: [thread({ id: "thread-1", workspace_id: "workspace-1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("workspace-1", "thread-1");
    useSessionStore.getState().setThreadDetail(
      threadDetail({
        items: [assistantMessage("msg-2", "second")],
        has_older: true,
        oldest_item_id: "msg-2",
      }),
    );

    const setError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useRelayStore.setState({
      _callRpc: vi
        .fn()
        .mockRejectedValue(
          new Error("Timed out waiting for thread.detail"),
        ) as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness
          .getActions()
          .loadThreadDetail("workspace-1", "thread-1", { older: true });
      });

      expect(setError).toHaveBeenCalledWith(
        "Couldn't load older messages. Try again.",
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
      warn.mockRestore();
    }
  });

  it("ignores stale detail responses after the user switches threads", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({ id: "workspace-1", current_thread_id: "thread-1" }),
          ],
          threads: [
            thread({ id: "thread-1", workspace_id: "workspace-1" }),
            thread({ id: "thread-2", workspace_id: "workspace-1" }),
          ],
        }),
      ),
    );
    useSessionStore.getState().selectThread("workspace-1", "thread-1");

    const deferred = createDeferred<ReturnType<typeof threadDetail>>();
    const rpc = vi.fn().mockReturnValue(deferred.promise);
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      const loadPromise = act(async () => {
        const pending = harness
          .getActions()
          .loadThreadDetail("workspace-1", "thread-1");
        useSessionStore.getState().selectThread("workspace-1", "thread-2");
        deferred.resolve(
          threadDetail({
            items: [assistantMessage("msg-late", "late")],
            has_older: false,
            oldest_item_id: "msg-late",
            newest_item_id: "msg-late",
            is_partial: true,
          }),
        );
        await pending;
      });
      await loadPromise;
    } finally {
      harness.unmount();
    }

    expect(useSessionStore.getState().selectedThreadId).toBe("thread-2");
    expect(useSessionStore.getState().threadDetail).toBeNull();
    expect(useSessionStore.getState().threadItems["thread-1"]).toBeUndefined();
  });

  it("discards an older page when a refresh changes its requested boundary", async () => {
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({ id: "workspace-1", current_thread_id: "thread-1" }),
          ],
          threads: [thread({ id: "thread-1", workspace_id: "workspace-1" })],
        }),
      ),
    );
    useSessionStore.getState().selectThread("workspace-1", "thread-1");
    useSessionStore.getState().setThreadDetail(
      threadDetail({
        items: [assistantMessage("old-boundary", "cached tail")],
        has_older: true,
        oldest_item_id: "old-boundary",
      }),
    );

    const deferred = createDeferred<ReturnType<typeof threadDetail>>();
    useRelayStore.setState({
      _callRpc: vi
        .fn()
        .mockReturnValue(deferred.promise) as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        const pending = harness
          .getActions()
          .loadThreadDetail("workspace-1", "thread-1", { older: true });
        useSessionStore.getState().setThreadDetail(
          threadDetail({
            items: [assistantMessage("fresh-boundary", "fresh tail")],
            has_older: true,
            oldest_item_id: "fresh-boundary",
          }),
        );
        deferred.resolve(
          threadDetail({
            items: [assistantMessage("stale-older", "stale page")],
            has_older: false,
            oldest_item_id: "stale-older",
          }),
        );
        await pending;
      });
    } finally {
      harness.unmount();
    }

    expect(
      useSessionStore
        .getState()
        .threadItems["thread-1"]?.map((item) => item.id),
    ).toEqual(["fresh-boundary"]);
  });
});

describe("handoffToProvider", () => {
  beforeEach(resetAll);

  function seedHandoffWorkspace() {
    const source = thread({
      id: "t1",
      workspace_id: "w1",
      title: "Fix the login bug",
      provider: "codex",
    });
    useSessionStore.getState().applyDaemonEvent(
      snapshotEvent(
        snapshot({
          workspaces: [
            workspace({
              id: "w1",
              path: "/tmp/project",
              current_thread_id: "t1",
              agents: [
                imageAgent("codex", true),
                {
                  ...imageAgent("claude", true),
                  label: "Claude",
                  models: [
                    {
                      id: "claude-opus",
                      label: "Opus",
                      is_default: true,
                      default_reasoning_effort: "medium",
                      supported_reasoning_efforts: [],
                    },
                  ],
                },
              ],
            }),
          ],
          threads: [source],
        }),
      ),
    );
    useSessionStore.getState().selectThread("w1", "t1");
    return source;
  }

  it("creates a linked destination, titles it, and seeds the source transcript", async () => {
    seedHandoffWorkspace();
    const destination = thread({
      id: "handoff-1",
      workspace_id: "w1",
      provider: "claude",
      title: "Fix the login bug · Claude",
    });
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread.detail") {
        return threadDetail({
          items: [userMessage("u1", "Where does auth happen?")],
        });
      }
      if (method === "thread.start") {
        return { workspace: workspace({ id: "w1" }), thread: destination };
      }
      if (method === "thread.update") {
        return {
          workspace: workspace({ id: "w1" }),
          thread: { ...destination, title: params.title as string },
        };
      }
      if (method === "turn.start") {
        return { ok: true };
      }
      return undefined;
    });
    const setError = vi.fn();
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().handoffToProvider("claude");
      });
      expect(harness.getActions().handoffPendingThreadKey).toBeNull();
    } finally {
      harness.unmount();
    }

    expect(rpc).toHaveBeenCalledWith(
      "thread.detail",
      expect.objectContaining({
        workspace_id: "w1",
        thread_id: "t1",
        mode: "full",
      }),
      { requestIdPrefix: "mobile-handoff-detail" },
    );
    expect(rpc).toHaveBeenCalledWith(
      "thread.start",
      expect.objectContaining({
        workspace_id: "w1",
        provider: "claude",
        model_id: "claude-opus",
        isolation: "project_folder",
        handoff_from: { thread_id: "t1", provider: "codex" },
      }),
      { requestIdPrefix: "mobile-handoff" },
    );
    expect(rpc).toHaveBeenCalledWith(
      "thread.update",
      expect.objectContaining({
        thread_id: "handoff-1",
        title: "Fix the login bug · Claude",
      }),
      { requestIdPrefix: "mobile-handoff" },
    );
    const turnCall = rpc.mock.calls.find(([method]) => method === "turn.start");
    expect(turnCall?.[1]).toEqual(
      expect.objectContaining({
        workspace_id: "w1",
        thread_id: "handoff-1",
        provider: "claude",
      }),
    );
    const turnInputs = (
      turnCall?.[1] as { inputs: { type: string; text: string }[] }
    ).inputs;
    expect(turnInputs[0]?.text).toContain("Where does auth happen?");
    expect(turnInputs[0]?.text).toContain("can still be resumed separately");
    expect(useSessionStore.getState().selectedThreadId).toBe("handoff-1");
    expect(setError).toHaveBeenCalledWith(null);
  });

  it("does not create a destination for the same agent", async () => {
    seedHandoffWorkspace();
    const rpc = vi.fn();
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: vi.fn() as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().handoffToProvider("codex");
      });
    } finally {
      harness.unmount();
    }

    expect(rpc).not.toHaveBeenCalled();
  });

  it("leaves the prompt in the destination composer when the seed turn does not start", async () => {
    seedHandoffWorkspace();
    const destination = thread({
      id: "handoff-1",
      workspace_id: "w1",
      provider: "claude",
      title: "Fix the login bug · Claude",
    });
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread.detail") {
        if (params.thread_id === "handoff-1") {
          return threadDetail({
            thread: destination,
            items: [],
          });
        }
        return threadDetail({
          items: [userMessage("u1", "Where does auth happen?")],
        });
      }
      if (method === "thread.start" || method === "thread.update") {
        return { workspace: workspace({ id: "w1" }), thread: destination };
      }
      if (method === "turn.start") {
        throw new Error("turn.start failed");
      }
      return undefined;
    });
    const setError = vi.fn();
    useRelayStore.setState({
      _callRpc: rpc as RelayStoreState["_callRpc"],
      _setError: setError as RelayStoreState["_setError"],
    } as Partial<RelayStoreState>);

    const harness = mountSessionActions();
    try {
      await act(async () => {
        await harness.getActions().handoffToProvider("claude");
      });
    } finally {
      harness.unmount();
    }

    expect(useSessionStore.getState().selectedThreadId).toBe("handoff-1");
    expect(useUIStore.getState().drafts[draftKeyFor("w1", "handoff-1")]?.text).toContain(
      "Where does auth happen?",
    );
    expect(setError).toHaveBeenCalledWith(
      "The handoff turn did not start. Its prompt is ready in the composer to resend.",
    );
  });
});
