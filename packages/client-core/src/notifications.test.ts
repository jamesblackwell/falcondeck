import { describe, expect, it } from "vitest";

import {
  notificationAction,
  notificationDays,
  notificationIsWaiting,
  type NotificationRecord,
} from "./notifications";

function record(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "N-1",
    seq: 1,
    kind: "turn_complete",
    title: "Fix login",
    preview: "Done.",
    created_at: "2026-11-04T10:00:00Z",
    importance: "normal",
    has_body: false,
    repeat_count: 0,
    ...overrides,
  };
}

describe("notificationAction", () => {
  const thread = { type: "thread", workspace_id: "w", thread_id: "t" } as const;

  it("opens a report before its target, which is the way back", () => {
    expect(notificationAction(record({ has_body: true, target: thread }))).toEqual({ type: "report" });
  });

  it("follows the target", () => {
    expect(notificationAction(record({ target: thread }))).toEqual(thread);
    expect(notificationAction(record({ target: { type: "review", review_id: "R-1" } }))).toEqual({
      type: "review",
      review_id: "R-1",
    });
  });

  it("falls back to the source thread, and to nothing", () => {
    expect(notificationAction(record({ workspace_id: "w", thread_id: "t" }))).toEqual(thread);
    expect(notificationAction(record({ thread_id: "t" }))).toEqual({ type: "none" });
  });
});

describe("notificationIsWaiting", () => {
  it("is an unresolved request or review", () => {
    expect(notificationIsWaiting(record({ kind: "review" }))).toBe(true);
    expect(notificationIsWaiting(record({ kind: "input_required" }))).toBe(true);
    expect(notificationIsWaiting(record({ kind: "review", resolved_at: "2026-11-04T11:00:00Z" }))).toBe(false);
    expect(notificationIsWaiting(record({ kind: "agent_notice" }))).toBe(false);
  });

  it("does not stop waiting because it was read", () => {
    expect(notificationIsWaiting(record({ kind: "review", read_at: "2026-11-04T11:00:00Z" }))).toBe(true);
  });
});

describe("notificationDays", () => {
  const now = new Date(2026, 10, 4, 15).getTime();
  const at = (day: number, hour = 9) => new Date(2026, 10, day, hour).toISOString();

  it("labels recent days and keeps the list order", () => {
    const days = notificationDays(
      [
        record({ id: "N-3", created_at: at(4, 12) }),
        record({ id: "N-2", created_at: at(4, 8) }),
        record({ id: "N-1", created_at: at(3) }),
      ],
      now,
    );
    expect(days.map((day) => day.label)).toEqual(["Today", "Yesterday"]);
    expect(days[0].items.map((item) => item.id)).toEqual(["N-3", "N-2"]);
  });

  it("names older days, with the year only when it differs", () => {
    const [thisYear, lastYear] = notificationDays(
      [record({ created_at: at(1) }), record({ created_at: new Date(2025, 10, 1).toISOString() })],
      now,
    );
    expect(thisYear.label).not.toMatch(/2026/);
    expect(lastYear.label).toMatch(/2025/);
  });

  it("is empty for an empty list", () => {
    expect(notificationDays([], now)).toEqual([]);
  });
});
