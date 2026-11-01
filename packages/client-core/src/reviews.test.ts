import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonApiClient } from "./daemon-client";
import { normalizePreferences } from "./normalization";
import {
  buildRespondArgs,
  isReviewDelivered,
  itemsAwaitingDecision,
  openReviews,
  reviewInboxEnabled,
  reviewOutcomeSummary,
  type Review,
  type ReviewDraft,
} from "./reviews";

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: "R-1",
    title: "Pricing page",
    ask: "Ship the new hero?",
    recommendation: "Ship B.",
    going_ahead_at: null,
    body: "",
    status: "open",
    items: [
      { id: "i1", title: "Hero", note: "", evidence: [], decision: null, feedback: null },
      { id: "i2", title: "Footer", note: "", evidence: [], decision: null, feedback: null },
    ],
    source_thread_id: "thread-1",
    source_workspace_id: "workspace-1",
    bot: "Juno",
    created_by: { name: "Juno", context: { origin: "mcp" } },
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    folder: null,
    responded_at: null,
    overall_decision: null,
    overall_note: null,
    delivery: null,
    ...overrides,
  } as Review;
}

afterEach(() => vi.unstubAllGlobals());

describe("review drafts", () => {
  it("needs a decision per item, or one overall decision", () => {
    const r = review();
    expect(itemsAwaitingDecision(r, { items: {} }).map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(buildRespondArgs(r, { items: { i1: { decision: "approve" } } })).toBeNull();
    expect(itemsAwaitingDecision(r, { items: {}, overall: { decision: "approve" } })).toEqual([]);
  });

  it("builds trimmed per-item arguments and drops empty feedback", () => {
    const draft: ReviewDraft = {
      items: {
        i1: { decision: "approve", feedback: "   " },
        i2: { decision: "request_changes", feedback: "  Smaller logo.\nKeep the badge. " },
      },
    };
    expect(buildRespondArgs(review(), draft)).toEqual({
      review_id: "R-1",
      items: [
        { item_id: "i1", decision: "approve" },
        { item_id: "i2", decision: "request_changes", feedback: "Smaller logo.\nKeep the badge." },
      ],
    });
  });

  it("builds an overall decision plus note, keeping any per-item overrides", () => {
    const draft: ReviewDraft = {
      items: { i2: { decision: "reject", feedback: "Cut it." } },
      overall: { decision: "approve", note: " Otherwise good. " },
    };
    expect(buildRespondArgs(review(), draft)).toEqual({
      review_id: "R-1",
      items: [{ item_id: "i2", decision: "reject", feedback: "Cut it." }],
      decision: "approve",
      note: "Otherwise good.",
    });
  });
});

describe("review lists", () => {
  it("shows open reviews newest first and summarises outcomes", () => {
    const rows = [
      review({ id: "R-1", created_at: "2026-11-01T09:00:00Z" }),
      review({ id: "R-2", created_at: "2026-11-01T11:00:00Z" }),
      review({ id: "R-3", status: "withdrawn" }),
    ];
    expect(openReviews(rows).map((r) => r.id)).toEqual(["R-2", "R-1"]);
    expect(reviewOutcomeSummary(rows[0]!)).toBe("Waiting on you");
    const done = review({
      status: "changes_requested",
      items: [
        { id: "i1", title: "A", note: "", evidence: [], decision: "approve", feedback: null },
        { id: "i2", title: "B", note: "", evidence: [], decision: "request_changes", feedback: "x" },
      ],
    });
    expect(reviewOutcomeSummary(done)).toBe("1 approve, 1 request changes");
  });

  it("reports delivery and treats older daemons as unsupported", () => {
    expect(isReviewDelivered(review())).toBeNull();
    expect(isReviewDelivered(review({ delivery: { state: "delivered", at: "x" } }))).toBe(true);
    expect(isReviewDelivered(review({ delivery: { state: "failed", at: "x", error: "gone" } }))).toBe(false);
    expect(reviewInboxEnabled(normalizePreferences({ version: 1 }))).toBe(false);
    expect(reviewInboxEnabled(normalizePreferences({ version: 1, review_inbox_enabled: true }))).toBe(true);
    expect(reviewInboxEnabled(normalizePreferences({ version: 1, review_inbox_enabled: false }))).toBe(false);
  });
});

describe("daemon client reviews", () => {
  it("pages through list results and posts responses through the control envelope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ resource: "reviews", data: [{ id: "R-2" }], next_cursor: "1" }))
      .mockResolvedValueOnce(Response.json({ resource: "reviews", data: [{ id: "R-1" }], next_cursor: null }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { id: "R-1", status: "approved" } }))
      .mockResolvedValueOnce(Response.json({ ok: false, error: { message: "R-1 is already approved." } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createDaemonApiClient("http://daemon.test");
    expect(await client.listReviews({ include_closed: true })).toEqual([{ id: "R-2" }, { id: "R-1" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://daemon.test/api/reviews?include_closed=true");
    expect(fetchMock.mock.calls[1]![0]).toBe("http://daemon.test/api/reviews?include_closed=true&cursor=1");

    await client.respondReview({ review_id: "R-1", decision: "approve" });
    const [url, init] = fetchMock.mock.calls[2]!;
    expect(url).toBe("http://daemon.test/api/reviews/R-1/respond");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ decision: "approve" });
    await expect(client.respondReview({ review_id: "R-1", decision: "approve" })).rejects.toThrow(
      "R-1 is already approved.",
    );
  });

  it("reads local files under the daemon policy and surfaces denials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("# Hi", { headers: { "X-FalconDeck-File-Version": "1:4", "content-type": "text/markdown" } }))
      .mockResolvedValueOnce(Response.json({ error: "file_denied: This file isn't shareable from your Mac." }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createDaemonApiClient("http://daemon.test");
    const file = await client.readFile({ path: "/tmp/a.md" });
    expect(await file.blob.text()).toBe("# Hi");
    expect(file.version).toBe("1:4");
    await expect(client.readFile({ path: "/Users/x/.env" })).rejects.toThrow("file_denied");
  });
});
