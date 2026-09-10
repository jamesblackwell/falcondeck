import { describe, expect, it } from "vitest";

import {
  formatAutomationCadence,
  formatCronCadence,
  formatDueAt,
  formatIntervalSeconds,
  formatScheduleCadence,
  formatTimezoneCity,
} from "./automation-schedule";

describe("formatCronCadence", () => {
  it("describes the common daily and weekly forms", () => {
    expect(formatCronCadence("0 12 * * *")).toBe("Every day at 12:00");
    expect(formatCronCadence("0 8 * * 1-5")).toBe("Weekdays at 08:00");
    expect(formatCronCadence("0 8 * * 0,6")).toBe("Weekends at 08:00");
    expect(formatCronCadence("10 1 * * 1")).toBe("Mondays at 01:10");
    expect(formatCronCadence("20 2 * * 1,4")).toBe("Mon and Thu at 02:20");
    expect(formatCronCadence("30 3,12 * * *")).toBe("Every day at 03:30 and 12:30");
    expect(formatCronCadence("35 6 1 * *")).toBe("Monthly on the 1st at 06:35");
  });

  it("describes intervals and hourly clocks", () => {
    expect(formatCronCadence("* * * * *")).toBe("Every minute");
    expect(formatCronCadence("*/15 * * * *")).toBe("Every 15 minutes");
    expect(formatCronCadence("0 * * * *")).toBe("Every hour");
    expect(formatCronCadence("0 */2 * * *")).toBe("Every 2 hours");
    expect(formatCronCadence("*/15 9-17 * * 1-5")).toBe(
      "Every 15 minutes from 09:00 to 17:00, weekdays",
    );
  });

  it("returns null for expressions that are not worth guessing", () => {
    expect(formatCronCadence("0 8 1,15 * 1")).toBeNull();
    expect(formatCronCadence("10,20 9-17 * * *")).toBeNull();
    expect(formatCronCadence("not a cron")).toBeNull();
    expect(formatCronCadence("0 8 * * * *")).toBeNull();
  });

  it("does not mistake a sparse hour list for a repeating interval", () => {
    expect(formatCronCadence("0 0,2 * * *")).toBe(
      "Every day at 00:00 and 02:00",
    );
  });
});

describe("formatScheduleCadence", () => {
  it("prefers a human cron reading over a raw resolved_schedule dump", () => {
    expect(
      formatScheduleCadence({
        trigger: {
          kind: "cron",
          expression: "0 8 * * 1-5",
          timezone: "Europe/London",
        },
        resolvedSchedule: 'cron "0 8 * * 1-5" (Europe/London)',
        viewerTimeZone: "Europe/London",
      }),
    ).toBe("Weekdays at 08:00");
  });

  it("keeps the schedule city when it differs from the viewer", () => {
    expect(
      formatScheduleCadence({
        trigger: {
          kind: "cron",
          expression: "0 12 * * *",
          timezone: "Europe/London",
        },
        viewerTimeZone: "UTC",
      }),
    ).toBe("Every day at 12:00 · London");
  });

  it("humanizes a stale cron resolved_schedule when the trigger is missing", () => {
    expect(
      formatScheduleCadence({
        resolvedSchedule: 'cron "0 8 * * 1-5" (Europe/London)',
        viewerTimeZone: "UTC",
      }),
    ).toBe("Weekdays at 08:00 · London");
  });

  it("formats intervals, one-off times, and legacy rrules", () => {
    expect(
      formatScheduleCadence({
        trigger: {
          kind: "interval",
          every_seconds: 900,
          anchor_at: "2026-09-07T00:00:00Z",
        },
      }),
    ).toBe("Every 15 minutes");
    expect(formatIntervalSeconds(60)).toBe("Every minute");
    expect(formatIntervalSeconds(3600)).toBe("Every hour");
    expect(
      formatScheduleCadence({
        legacySchedule: {
          kind: "recurring",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
          timezone: "Europe/London",
        },
        viewerTimeZone: "Europe/London",
      }),
    ).toBe("Every day at 09:00");
    expect(
      formatScheduleCadence({
        legacySchedule: {
          kind: "recurring",
          rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
          timezone: "UTC",
        },
        viewerTimeZone: "UTC",
      }),
    ).toBe("Mondays at 09:00");
    expect(
      formatScheduleCadence({
        legacySchedule: {
          kind: "recurring",
          rrule: "FREQ=MINUTELY;INTERVAL=15",
          timezone: "UTC",
        },
        viewerTimeZone: "UTC",
      }),
    ).toBe("Every 15 minutes");
  });

  it("rewrites automation list rows the same way", () => {
    expect(
      formatAutomationCadence({
        trigger: {
          kind: "cron",
          expression: "50 5 * * 1,4",
          timezone: "UTC",
        },
        resolved_schedule: 'cron "50 5 * * 1,4" (UTC)',
      }, "UTC"),
    ).toBe("Mon and Thu at 05:50");
  });
});

describe("formatTimezoneCity", () => {
  it("uses the last IANA path segment", () => {
    expect(formatTimezoneCity("Europe/London")).toBe("London");
    expect(formatTimezoneCity("America/New_York")).toBe("New York");
    expect(formatTimezoneCity("UTC")).toBe("UTC");
  });
});

describe("formatDueAt", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");

  it("uses compact relative labels for the next day and a half", () => {
    expect(formatDueAt("2026-09-07T12:00:20Z", now)?.label).toBe("Now");
    expect(formatDueAt("2026-09-07T12:12:00Z", now)?.label).toBe("in 12m");
    expect(formatDueAt("2026-09-07T16:00:00Z", now)?.label).toBe("in 4h");
    expect(formatDueAt("2026-09-07T11:00:00Z", now)?.label).toBe("Overdue");
    expect(formatDueAt("2026-09-07T11:00:00Z", now)?.overdue).toBe(true);
  });

  it("returns null for missing timestamps", () => {
    expect(formatDueAt(null, now)).toBeNull();
    expect(formatDueAt("not-a-date", now)).toBeNull();
  });
});
