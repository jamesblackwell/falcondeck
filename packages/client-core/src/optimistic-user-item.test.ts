import { describe, expect, it } from "vitest";

import {
  buildOptimisticUserItem,
  generateUserItemId,
  mergeThreadDetailPage,
  removeConversationItem,
  upsertConversationItem,
} from "./conversation";
import type { ConversationItem, ThreadDetail } from "./types";

function userItem(
  id: string,
  text: string,
  options: { pending?: boolean; createdAt?: string } = {},
): ConversationItem {
  return {
    kind: "user_message",
    id,
    text,
    attachments: [],
    created_at: options.createdAt ?? "2026-08-11T10:00:00.000Z",
    ...(options.pending ? { pending: true } : {}),
  };
}

function detailWith(items: ConversationItem[]): ThreadDetail {
  return {
    workspace: { id: "workspace-1" },
    thread: { id: "thread-1" },
    items,
    has_older: false,
    oldest_item_id: items[0]?.id ?? null,
    newest_item_id: items.at(-1)?.id ?? null,
    is_partial: false,
  } as ThreadDetail;
}

describe("generateUserItemId", () => {
  it("mints daemon-shaped ids the sanitizer accepts", () => {
    const id = generateUserItemId();
    expect(id).toMatch(/^user-[0-9a-f]{32}$/);
    expect(generateUserItemId()).not.toBe(id);
  });
});

describe("buildOptimisticUserItem", () => {
  it("assembles text and attachments the way the daemon does", () => {
    const item = buildOptimisticUserItem(
      "user-abc",
      [
        { type: "text", text: "first" },
        {
          type: "image",
          id: "img-1",
          name: null,
          mime_type: "image/png",
          url: "file:///tmp/a.png",
          local_path: "/tmp/a.png",
        },
        { type: "text", text: "second" },
      ],
      "2026-08-11T10:00:00.000Z",
    );
    expect(item).toMatchObject({
      kind: "user_message",
      id: "user-abc",
      text: "first\n\nsecond",
      pending: true,
    });
    expect(
      item.kind === "user_message" ? item.attachments.map((a) => a.id) : [],
    ).toEqual(["img-1"]);
  });
});

describe("optimistic reconciliation in upsertConversationItem", () => {
  it("replaces the pending item in place when the echo shares its id", () => {
    const optimistic = userItem("user-abc", "hello", { pending: true });
    const echo = userItem("user-abc", "hello", {
      createdAt: "2026-08-11T10:00:01.000Z",
    });
    const items = upsertConversationItem([optimistic], echo);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "user-abc", text: "hello" });
    expect(
      items[0].kind === "user_message" ? items[0].pending : undefined,
    ).toBeUndefined();
    // The echo keeps the optimistic anchor so the message doesn't jump.
    expect(items[0].created_at).toBe("2026-08-11T10:00:00.000Z");
  });

  it("folds an old-daemon echo (different id, same text) into the pending item", () => {
    const optimistic = userItem("user-client", "hello", { pending: true });
    const echo = userItem("user-daemon", "hello", {
      createdAt: "2026-08-11T10:00:01.000Z",
    });
    const items = upsertConversationItem([optimistic], echo);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("user-daemon");
  });

  it("does not fold an unrelated user message into a pending one", () => {
    const optimistic = userItem("user-client", "hello", { pending: true });
    const other = userItem("user-daemon", "different", {
      createdAt: "2026-08-11T10:00:01.000Z",
    });
    const items = upsertConversationItem([optimistic], other);
    expect(items).toHaveLength(2);
  });

  it("never folds into an already-acknowledged message with the same text", () => {
    const acknowledged = userItem("user-first", "same words");
    const echo = userItem("user-second", "same words", {
      createdAt: "2026-08-11T10:00:01.000Z",
    });
    const items = upsertConversationItem([acknowledged], echo);
    expect(items).toHaveLength(2);
  });
});

describe("removeConversationItem", () => {
  it("removes by id and returns the same array when absent", () => {
    const items = [userItem("user-a", "one"), userItem("user-b", "two")];
    expect(removeConversationItem(items, "user-a").map((i) => i.id)).toEqual([
      "user-b",
    ]);
    expect(removeConversationItem(items, "user-missing")).toBe(items);
  });
});

describe("mergeThreadDetailPage with pending items", () => {
  const now = new Date().toISOString();

  it("keeps a fresh pending item a tail refresh raced past", () => {
    const acknowledged = userItem("user-old", "earlier");
    const pending = userItem("user-new", "just sent", {
      pending: true,
      createdAt: now,
    });
    const merged = mergeThreadDetailPage(
      detailWith([acknowledged, pending]),
      detailWith([acknowledged]),
      "refresh",
    );
    expect(merged.items.map((item) => item.id)).toEqual([
      "user-old",
      "user-new",
    ]);
    expect(merged.newest_item_id).toBe("user-new");
  });

  it("drops the pending copy when the page already contains the echo", () => {
    const acknowledged = userItem("user-old", "earlier");
    const pending = userItem("user-new", "just sent", {
      pending: true,
      createdAt: now,
    });
    const echoed = userItem("user-new", "just sent", { createdAt: now });
    const merged = mergeThreadDetailPage(
      detailWith([acknowledged, pending]),
      detailWith([acknowledged, echoed]),
      "refresh",
    );
    expect(merged.items).toHaveLength(2);
    expect(
      merged.items[1].kind === "user_message"
        ? merged.items[1].pending
        : undefined,
    ).toBeUndefined();
  });

  it("drops a same-text echo under an old-daemon id", () => {
    const acknowledged = userItem("user-old", "earlier");
    const pending = userItem("user-client", "just sent", {
      pending: true,
      createdAt: now,
    });
    const echoed = userItem("user-daemon", "just sent", { createdAt: now });
    const merged = mergeThreadDetailPage(
      detailWith([acknowledged, pending]),
      detailWith([acknowledged, echoed]),
      "refresh",
    );
    expect(merged.items.map((item) => item.id)).toEqual([
      "user-old",
      "user-daemon",
    ]);
  });

  it("expires a stale pending item instead of preserving it forever", () => {
    const acknowledged = userItem("user-old", "earlier");
    const stalePending = userItem("user-stale", "lost message", {
      pending: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const merged = mergeThreadDetailPage(
      detailWith([acknowledged, stalePending]),
      detailWith([acknowledged]),
      "refresh",
    );
    expect(merged.items.map((item) => item.id)).toEqual(["user-old"]);
  });
});
