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
