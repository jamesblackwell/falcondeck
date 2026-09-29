import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationItem } from "@falcondeck/client-core";

import { useRelayStore, useSessionStore } from "@/store";
import {
  imageNeedsFetch,
  loadFullThreadItem,
  resetThreadItemLoaderForTests,
  toolOutputIsTruncated,
} from "./thread-item-loader";

function toolCall(
  id: string,
  output: string,
  totalBytes?: number,
): Extract<ConversationItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id,
    title: "cat file",
    tool_kind: "command",
    status: "completed",
    output,
    exit_code: 0,
    display: {
      is_read_only: true,
      has_side_effect: false,
      is_error: false,
      artifact_kind: "command_output",
      activity_kind: "command",
      history_mode: "full",
      summary_hint: null,
      ...(totalBytes ? { output_total_bytes: totalBytes } : {}),
    },
    detail: null,
    created_at: "2026-09-06T10:00:00Z",
    completed_at: "2026-09-06T10:00:01Z",
  };
}

function runningToolCall(id: string, output: string, totalBytes?: number) {
  return {
    ...toolCall(id, output, totalBytes),
    status: "running",
    exit_code: null,
    completed_at: null,
  };
}

describe("imageNeedsFetch", () => {
  it("fetches stripped data URLs and daemon-local paths only", () => {
    expect(
      imageNeedsFetch({ url: "", local_path: "/tmp/shot.png", mime_type: null }),
    ).toBe(true);
    expect(imageNeedsFetch({ url: "", mime_type: "image/png" })).toBe(true);
    expect(
      imageNeedsFetch({ url: "/tmp/shot.png", local_path: "/tmp/shot.png" }),
    ).toBe(true);
    // Nothing to fetch, or already renderable, or refused outright.
    expect(imageNeedsFetch({ url: "" })).toBe(false);
    expect(imageNeedsFetch({ url: "data:image/png;base64,AAAA" })).toBe(false);
    expect(imageNeedsFetch({ url: "https://example.com/a.png" })).toBe(false);
    expect(
      imageNeedsFetch({ url: "javascript:alert(1)", mime_type: "image/png" }),
    ).toBe(false);
    expect(
      imageNeedsFetch({
        url: "https://user:secret@example.com/a.png",
        mime_type: "image/png",
      }),
    ).toBe(false);
  });
});

describe("loadFullThreadItem", () => {
  it('bounds cached output bytes and still returns oversized selected items', async () => {
    const rpc = vi.fn((_method, params) => Promise.resolve(
      toolCall(params.item_id, 'x'.repeat(params.item_id === 'huge' ? 5 * 1024 * 1024 : 2 * 1024 * 1024)),
    ))
    useRelayStore.setState({ sessionId: 'session-1', _callRpc: rpc } as never)
    await loadFullThreadItem('workspace-1', 'thread-1', 'one')
    await loadFullThreadItem('workspace-1', 'thread-1', 'two')
    await loadFullThreadItem('workspace-1', 'thread-1', 'three')
    await loadFullThreadItem('workspace-1', 'thread-1', 'one')
    expect(rpc).toHaveBeenCalledTimes(4)
    const huge = await loadFullThreadItem('workspace-1', 'thread-1', 'huge')
    expect(huge?.kind === 'tool_call' && huge.output?.length).toBe(5 * 1024 * 1024)
    await loadFullThreadItem('workspace-1', 'thread-1', 'huge')
    expect(rpc).toHaveBeenCalledTimes(6)
  })
  beforeEach(() => {
    resetThreadItemLoaderForTests();
    useSessionStore.setState({
      selectedWorkspaceId: "workspace-1",
      selectedThreadId: "thread-1",
      threadItems: { "thread-1": [toolCall("tool-1", "head", 40_000)] },
      threadHistory: {},
      threadDetail: null,
    } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swaps the full item into the transcript once and dedupes concurrent calls", async () => {
    const rpc = vi.fn().mockResolvedValue(toolCall("tool-1", "the whole output"));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);

    const [a, b] = await Promise.all([
      loadFullThreadItem("workspace-1", "thread-1", "tool-1"),
      loadFullThreadItem("workspace-1", "thread-1", "tool-1"),
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "thread.item",
      { workspace_id: "workspace-1", thread_id: "thread-1", item_id: "tool-1" },
      { requestIdPrefix: "mobile-item" },
    );
    expect(a).toBe(b);
    const item = useSessionStore.getState().threadItems["thread-1"]?.[0];
    expect(item?.kind === "tool_call" && item.output).toBe("the whole output");
    expect(toolOutputIsTruncated(item as never)).toBe(false);

    // A later trimmed page re-applies the cut item; the cached full copy is
    // restored without another round trip.
    useSessionStore.setState({
      threadItems: { "thread-1": [toolCall("tool-1", "head", 40_000)] },
    } as never);
    await loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    expect(rpc).toHaveBeenCalledTimes(1);
    const restored = useSessionStore.getState().threadItems["thread-1"]?.[0];
    expect(restored?.kind === "tool_call" && restored.output).toBe(
      "the whole output",
    );
  });

  it("never appends an item the transcript no longer holds", async () => {
    const rpc = vi.fn().mockResolvedValue(toolCall("tool-9", "late"));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    await loadFullThreadItem("workspace-1", "thread-1", "tool-9");
    expect(useSessionStore.getState().threadItems["thread-1"]).toHaveLength(1);
  });

  it("records failures and lets a retry go back to the daemon", async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(toolCall("tool-1", "recovered"));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    await expect(
      loadFullThreadItem("workspace-1", "thread-1", "tool-1"),
    ).rejects.toThrow("offline");
    await loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    expect(rpc).toHaveBeenCalledTimes(2);
    const item = useSessionStore.getState().threadItems["thread-1"]?.[0];
    expect(item?.kind === "tool_call" && item.output).toBe("recovered");
  });

  it("never reuses an item from a different paired session", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce(toolCall("tool-1", "old daemon"))
      .mockResolvedValueOnce(toolCall("tool-1", "new daemon"));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    await loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    useRelayStore.setState({ sessionId: "session-2" });
    useSessionStore.setState({
      threadItems: { "thread-1": [toolCall("tool-1", "head", 40_000)] },
    } as never);

    await loadFullThreadItem("workspace-1", "thread-1", "tool-1");

    expect(rpc).toHaveBeenCalledTimes(2);
    const item = useSessionStore.getState().threadItems["thread-1"]?.[0];
    expect(item?.kind === "tool_call" && item.output).toBe("new daemon");
  });

  it("refetches a running tool after its output changes", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce(runningToolCall("tool-1", "old full output"))
      .mockResolvedValueOnce(toolCall("tool-1", "final full output"));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    useSessionStore.setState({
      threadItems: { "thread-1": [runningToolCall("tool-1", "old", 40_000)] },
    } as never);

    await loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    useSessionStore.setState({
      threadItems: { "thread-1": [toolCall("tool-1", "final", 50_000)] },
    } as never);
    await loadFullThreadItem("workspace-1", "thread-1", "tool-1");

    expect(rpc).toHaveBeenCalledTimes(2);
    const item = useSessionStore.getState().threadItems["thread-1"]?.[0];
    expect(item?.kind === "tool_call" && item.output).toBe("final full output");
  });

  it("does not replace a newer tool update with an earlier in-flight response", async () => {
    let complete!: (item: ConversationItem) => void;
    const rpc = vi.fn(() => new Promise<ConversationItem>((resolve) => {
      complete = resolve;
    }));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    useSessionStore.setState({
      threadItems: { "thread-1": [runningToolCall("tool-1", "old", 40_000)] },
    } as never);

    const load = loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    await Promise.resolve();
    useSessionStore.setState({
      threadItems: { "thread-1": [toolCall("tool-1", "final full output")] },
    } as never);
    complete(runningToolCall("tool-1", "old full output"));
    await load;

    const item = useSessionStore.getState().threadItems["thread-1"]?.[0];
    expect(item?.kind === "tool_call" && item.output).toBe("final full output");
    expect(item?.kind === "tool_call" && item.status).toBe("completed");
  });

  it("fetches the final output when a completed page overtakes a running response", async () => {
    let completeRunning!: (item: ConversationItem) => void;
    const rpc = vi.fn()
      .mockImplementationOnce(() => new Promise<ConversationItem>((resolve) => {
        completeRunning = resolve;
      }))
      .mockResolvedValueOnce(toolCall("tool-1", "final full output"));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    useSessionStore.setState({
      threadItems: { "thread-1": [runningToolCall("tool-1", "old", 40_000)] },
    } as never);

    const load = loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    await Promise.resolve();
    useSessionStore.setState({
      threadItems: { "thread-1": [toolCall("tool-1", "final", 50_000)] },
    } as never);
    completeRunning(runningToolCall("tool-1", "old full output"));
    await load;

    expect(rpc).toHaveBeenCalledTimes(2);
    const item = useSessionStore.getState().threadItems["thread-1"]?.[0];
    expect(item?.kind === "tool_call" && item.output).toBe("final full output");
  });

  it("bounds an image-heavy render to two concurrent full-item transfers", async () => {
    const completions: ((item: ConversationItem) => void)[] = [];
    const rpc = vi.fn(() => new Promise<ConversationItem>((resolve) => {
      completions.push(resolve);
    }));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    const loads = [1, 2, 3, 4].map((id) =>
      loadFullThreadItem("workspace-1", "thread-1", `tool-${id}`),
    );
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(2);

    completions[0]!(toolCall("tool-1", "one"));
    await loads[0];
    expect(rpc).toHaveBeenCalledTimes(3);
    completions[1]!(toolCall("tool-2", "two"));
    await loads[1];
    expect(rpc).toHaveBeenCalledTimes(4);
    completions[2]!(toolCall("tool-3", "three"));
    completions[3]!(toolCall("tool-4", "four"));
    await Promise.all(loads);
  });

  it("drops queued thumbnails when the reader changes threads", async () => {
    const completions: ((item: ConversationItem) => void)[] = [];
    const rpc = vi.fn(() => new Promise<ConversationItem>((resolve) => {
      completions.push(resolve);
    }));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    const first = loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    const second = loadFullThreadItem("workspace-1", "thread-1", "tool-2");
    const queued = loadFullThreadItem("workspace-1", "thread-1", "tool-3");
    await Promise.resolve();
    useSessionStore.setState({ selectedThreadId: "thread-2" });
    completions[0]!(toolCall("tool-1", "late"));
    completions[1]!(toolCall("tool-2", "late"));

    expect(await queued).toBeNull();
    await Promise.all([first, second]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("starts the selected thread's transfers while old thread transfers finish", async () => {
    const completions: ((item: ConversationItem) => void)[] = [];
    const rpc = vi.fn(() => new Promise<ConversationItem>((resolve) => {
      completions.push(resolve);
    }));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    const first = loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    const second = loadFullThreadItem("workspace-1", "thread-1", "tool-2");
    const staleQueued = loadFullThreadItem("workspace-1", "thread-1", "tool-3");
    await Promise.resolve();
    useSessionStore.setState({
      selectedThreadId: "thread-2",
      threadItems: { "thread-2": [toolCall("tool-4", "head", 40_000)] },
    } as never);
    const current = loadFullThreadItem("workspace-1", "thread-2", "tool-4");
    await Promise.resolve();

    expect(rpc).toHaveBeenCalledTimes(3);
    completions[2]!(toolCall("tool-4", "new thread"));
    await current;
    completions[0]!(toolCall("tool-1", "old thread"));
    completions[1]!(toolCall("tool-2", "old thread"));
    const oldResults = await Promise.all([first, second, staleQueued]);
    expect(oldResults.map((item) => item?.id ?? null)).toEqual([
      "tool-1", "tool-2", null,
    ]);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(useSessionStore.getState().threadItems["thread-2"]?.[0]).toMatchObject({
      id: "tool-4", output: "new thread",
    });
  });

  it("does not let old-session transfers block or overwrite the new session", async () => {
    const completions: ((item: ConversationItem) => void)[] = [];
    const rpc = vi.fn(() => new Promise<ConversationItem>((resolve) => {
      completions.push(resolve);
    }));
    useRelayStore.setState({ sessionId: "session-1", _callRpc: rpc } as never);
    const first = loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    const second = loadFullThreadItem("workspace-1", "thread-1", "tool-2");
    const queued = loadFullThreadItem("workspace-1", "thread-1", "tool-3");
    await Promise.resolve();
    useRelayStore.setState({ sessionId: "session-2" });
    const current = loadFullThreadItem("workspace-1", "thread-1", "tool-1");
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(3);
    completions[2]!(toolCall("tool-1", "new session"));
    await current;
    completions[0]!(toolCall("tool-1", "stale"));
    completions[1]!(toolCall("tool-2", "stale"));

    expect(await Promise.all([first, second, queued])).toEqual([null, null, null]);
    expect(rpc).toHaveBeenCalledTimes(3);
    const item = useSessionStore.getState().threadItems["thread-1"]?.[0];
    expect(item?.kind === "tool_call" && item.output).toBe("new session");
  });
});
