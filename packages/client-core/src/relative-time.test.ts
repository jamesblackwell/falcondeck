import { describe, expect, it } from "vitest";

import { formatReceivedAgo } from "./relative-time";

const NOW = Date.parse("2026-03-16T12:00:00Z");

describe("formatReceivedAgo", () => {
  it("returns now for timestamps less than a minute old", () => {
    expect(formatReceivedAgo("2026-03-16T12:00:00Z", NOW)).toBe("now");
    expect(formatReceivedAgo("2026-03-16T11:59:30Z", NOW)).toBe("now");
  });

  it("returns compact minutes, hours, and days", () => {
    expect(formatReceivedAgo("2026-03-16T11:59:00Z", NOW)).toBe("1m ago");
    expect(formatReceivedAgo("2026-03-16T11:00:00Z", NOW)).toBe("1h ago");
    expect(formatReceivedAgo("2026-03-15T12:00:00Z", NOW)).toBe("1d ago");
    expect(formatReceivedAgo("2026-03-09T12:00:00Z", NOW)).toBe("7d ago");
  });

  it("treats future timestamps as now", () => {
    expect(formatReceivedAgo("2026-03-16T13:00:00Z", NOW)).toBe("now");
  });

  it("returns null for invalid dates", () => {
    expect(formatReceivedAgo("not-a-date", NOW)).toBeNull();
  });
});
