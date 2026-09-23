import { describe, expect, it } from "vitest";

import {
  applyConversationEventsToItems,
  mergeThreadDetailPage,
} from "./conversation";
import type { ConversationItem, EventEnvelope, ThreadDetail } from "./types";

const at = "2026-08-09T12:00:00Z";
type AssistantMessage = Extract<
  ConversationItem,
  { kind: "assistant_message" }
>;

function assistant(id: string, text = id): AssistantMessage {
  return {
    kind: "assistant_message",
    id,
    text,
    phase: "final_answer",
    memory_citation: null,
    citations: [],
    lifecycle: "complete",
    created_at: at,
  };
}

function assistantWithLifecycle(
  id: string,
  text: string,
  lifecycle: "streaming" | "interrupted",
): AssistantMessage {
  return { ...assistant(id, text), lifecycle };
}

function detail(
  ids: string[],
  options: {
    hasOlder?: boolean;
    threadId?: string;
    text?: Record<string, string>;
  } = {},
): ThreadDetail {
  const items = ids.map((id) => assistant(id, options.text?.[id] ?? id));
  return {
    workspace: { id: "workspace-1" },
    thread: { id: options.threadId ?? "thread-1" },
    items,
    has_older: options.hasOlder ?? false,
    oldest_item_id: items[0]?.id ?? null,
    newest_item_id: items.at(-1)?.id ?? null,
    is_partial: options.hasOlder ?? false,
  } as ThreadDetail;
}

describe("mergeThreadDetailPage", () => {
  it("prepends earlier turns above an ordinary user boundary regardless of timestamps", () => {
    const current = detail(["user", "answer"], { hasOlder: true });
    current.items[0] = {
      kind: "user_message",
      id: "user",
      text: "latest prompt",
      attachments: [],
      created_at: "2026-08-09T11:00:00Z",
    };
    const merged = mergeThreadDetailPage(current, detail(["earlier-answer"]), "prepend");

    expect(merged.items.map((item) => item.id)).toEqual([
      "earlier-answer", "user", "answer",
    ]);
  });

  it("prepends an overlapping older page once and adopts its history boundary", () => {
    const current = detail(["b", "c", "d"], { hasOlder: true });
    const page = detail(["a", "b"], {
      hasOlder: false,
      text: { b: "authoritative b" },
    });

    const merged = mergeThreadDetailPage(current, page, "prepend");

    expect(
      merged.items.map(
        (item) =>
          `${item.id}:${item.kind === "assistant_message" ? item.text : ""}`,
      ),
    ).toEqual(["a:a", "b:authoritative b", "c:c", "d:d"]);
    expect(merged.has_older).toBe(false);
    expect(merged.is_partial).toBe(false);
    expect(merged.oldest_item_id).toBe("a");
    expect(merged.newest_item_id).toBe("d");
  });

  it("replaces the authoritative tail while preserving a continuous loaded prefix", () => {
    const current = detail(["a", "b", "c", "stale"], { hasOlder: false });
    const page = detail(["c", "d"], {
      hasOlder: true,
      text: { c: "updated c" },
    });

    const merged = mergeThreadDetailPage(current, page, "refresh");

    expect(merged.items.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(merged.items[2]).toMatchObject({ text: "updated c" });
    expect(merged.has_older).toBe(false);
    expect(merged.is_partial).toBe(false);
  });

  it("keeps an empty replaying refresh partial until items arrive", () => {
    const replaying = { ...detail([]), is_partial: true };

    expect(mergeThreadDetailPage(detail([]), replaying, "refresh").is_partial).toBe(true);
    const landed = { ...detail(["a"]), is_partial: true };
    expect(mergeThreadDetailPage(replaying, landed, "refresh").is_partial).toBe(false);
  });

  it("trusts a fresh non-overlapping tail instead of joining unrelated history", () => {
    const merged = mergeThreadDetailPage(
      detail(["old-a", "old-b"], { hasOlder: true }),
      detail(["new-a", "new-b"], { hasOlder: true }),
      "refresh",
    );

    expect(merged.items.map((item) => item.id)).toEqual(["new-a", "new-b"]);
    expect(merged.has_older).toBe(true);
  });

  it("adopts an interrupted authoritative tail without duplicating partial content", () => {
    const current = detail(["user-boundary", "answer"], {
      text: { answer: "Partial answer retained across reconnect." },
    });
    current.items[1] = assistantWithLifecycle(
      "answer",
      "Partial answer retained across reconnect.",
      "streaming",
    );
    const page = detail(["user-boundary", "answer"]);
    page.items[1] = assistantWithLifecycle(
      "answer",
      "Partial answer retained across reconnect.",
      "interrupted",
    );

    const merged = mergeThreadDetailPage(current, page, "refresh");

    expect(merged.items.map((item) => item.id)).toEqual([
      "user-boundary",
      "answer",
    ]);
    expect(merged.items[1]).toMatchObject({
      text: "Partial answer retained across reconnect.",
      lifecycle: "interrupted",
    });
  });

  it("replaces a cached truncated tail and treats retained delta replay as a no-op", () => {
    const cached = detail(["user", "answer"], {
      text: { answer: "Cached partial answer" },
    });
    cached.items[1] = assistantWithLifecycle(
      "answer",
      "Cached partial answer",
      "streaming",
    );
    const authoritative = detail(["user", "answer", "next"], {
      text: {
        answer: "Authoritative complete response.",
        next: "Retained update recovered once.",
      },
    });
    const merged = mergeThreadDetailPage(cached, authoritative, "refresh");
    const suffix = "response.";
    const completeText = "Authoritative complete response.";
    const replay: EventEnvelope = {
      seq: 42,
      emitted_at: at,
      workspace_id: "workspace-1",
      thread_id: "thread-1",
      event: {
        type: "text",
        item_id: "answer",
        delta: suffix,
        start_offset: completeText.length - suffix.length,
        end_offset: completeText.length,
      },
    };

    const afterReplay = applyConversationEventsToItems(merged.items, [
      replay,
      replay,
    ]);

    expect(merged.items.map((item) => item.id)).toEqual([
      "user",
      "answer",
      "next",
    ]);
    expect(afterReplay).toBe(merged.items);
    expect(afterReplay.filter((item) => item.id === "answer")).toHaveLength(1);
    expect(afterReplay[1]).toMatchObject({
      text: completeText,
      lifecycle: "complete",
    });
  });

  it("keeps the daemon cursor when a tail page pins the turn's prompt above its window", () => {
    // Strict mobile pages: prompt (older) + the last 3 items; the cursor
    // names the first contiguous item, not the pinned prompt.
    const prompt: ConversationItem = {
      kind: "user_message",
      id: "user-1",
      text: "fix it",
      attachments: [],
      created_at: at,
    };
    const page: ThreadDetail = {
      ...detail(["tool-5", "tool-6", "tool-7"], { hasOlder: true }),
      items: [prompt, assistant("tool-5"), assistant("tool-6"), assistant("tool-7")],
      oldest_item_id: "tool-5",
    };

    const merged = mergeThreadDetailPage(null, page, "refresh");
    expect(merged.oldest_item_id).toBe("tool-5");
    expect(merged.items.map((item) => item.id)).toEqual([
      "user-1",
      "tool-5",
      "tool-6",
      "tool-7",
    ]);

    // An older page that still doesn't reach the prompt lands under it.
    const older = detail(["tool-2", "tool-3", "tool-4"], { hasOlder: true });
    const prepended = mergeThreadDetailPage(merged, older, "prepend");
    expect(prepended.items.map((item) => item.id)).toEqual([
      "user-1",
      "tool-2",
      "tool-3",
      "tool-4",
      "tool-5",
      "tool-6",
      "tool-7",
    ]);
    expect(prepended.oldest_item_id).toBe("tool-2");

    // The page that contains the prompt replaces the pinned copy in place.
    const oldest: ThreadDetail = {
      ...detail(["tool-0", "tool-1"]),
      items: [prompt, assistant("tool-0"), assistant("tool-1")],
      oldest_item_id: "user-1",
    };
    const complete = mergeThreadDetailPage(prepended, oldest, "prepend");
    expect(complete.items.map((item) => item.id)).toEqual([
      "user-1",
      "tool-0",
      "tool-1",
      "tool-2",
      "tool-3",
      "tool-4",
      "tool-5",
      "tool-6",
      "tool-7",
    ]);
    expect(complete.oldest_item_id).toBe("user-1");
    expect(complete.has_older).toBe(false);
  });

  it("never merges pages belonging to different threads", () => {
    const page = detail(["other"], { threadId: "thread-2" });
    expect(mergeThreadDetailPage(detail(["current"]), page, "prepend")).toBe(
      page,
    );
  });
});
