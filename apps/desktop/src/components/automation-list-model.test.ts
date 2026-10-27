import { describe, expect, it } from "vitest";
import type { Automation } from "@falcondeck/client-core";
import {
  automationProject,
  filterAutomationEntries,
  groupAutomationEntries,
  summarizeAutomationEntries,
  type AutomationListFilters,
  type TaskEntry,
} from "./automation-list-model";

const filters: AutomationListFilters = {
  query: "", status: "all", host: "all", project: "all", activity: "all", sort: "next",
};

function entry(title: string, task: Partial<TaskEntry["task"]> = {}, extra: Partial<TaskEntry> = {}): TaskEntry {
  return {
    hostId: null, hostName: "This Mac", online: true, supported: true,
    workspaces: [{ id: "ws", path: "/sites/falcondeck" }] as TaskEntry["workspaces"],
    automation: null,
    task: {
      id: title, title, status: "active", provider: "codex", workspace_id: "ws",
      prompt_preview: "Check billing webhooks",
      schedule: { kind: "recurring", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", timezone: "UTC" },
      updated_at: "2026-10-01T08:00:00Z", ...task,
    }, ...extra,
  };
}

function run(status: NonNullable<TaskEntry["task"]["last_run"]>["status"], scheduledFor = "2026-10-01T09:00:00Z") {
  return { status, scheduled_for: scheduledFor } as NonNullable<TaskEntry["task"]["last_run"]>;
}

const titles = (entries: TaskEntry[], patch: Partial<AutomationListFilters> = {}) =>
  filterAutomationEntries(entries, { ...filters, ...patch }, "UTC").map((item) => item.task.title);

describe("automation list", () => {
  it("puts current work first, followed by scheduled runs, with missing dates last", () => {
    const entries = [
      entry("No date"),
      entry("Later", { next_run_at: "2026-10-06T08:00:00Z" }),
      entry("Paused", { status: "paused", next_run_at: "2026-09-01T08:00:00Z" }),
      entry("Sooner", { next_run_at: "2026-10-05T08:00:00Z" }),
      entry("Running", { last_run: run("running") }),
      entry("Invalid", { next_run_at: "invalid" }),
    ];
    expect(titles(entries)).toEqual(["Running", "Sooner", "Later", "Invalid", "No date", "Paused"]);
    expect(entries[0].task.title).toBe("No date");
  });

  it("sorts names naturally and dates newest first without promoting missing dates", () => {
    const entries = [
      entry("Check 10", { updated_at: "2026-10-01T08:00:00Z", last_run: run("succeeded", "2026-10-03T08:00:00Z") }),
      entry("check 2", { updated_at: "2026-10-02T08:00:00Z", last_run: run("failed", "2026-10-01T08:00:00Z") }),
      entry("Never run", { updated_at: "invalid" }),
    ];
    expect(titles(entries, { sort: "name" })).toEqual(["check 2", "Check 10", "Never run"]);
    expect(titles(entries, { sort: "updated" })).toEqual(["check 2", "Check 10", "Never run"]);
    expect(titles(entries, { sort: "last_run" })).toEqual(["Check 10", "check 2", "Never run"]);
  });

  it("keeps extension-owned records in their section for every sort", () => {
    const owned = entry("A extension", { next_run_at: "2026-10-01T08:00:00Z" }, {
      automation: { owner: { extension_id: "test", resource_id: "resource" } } as Automation,
    });
    for (const sort of ["next", "name", "updated", "last_run"] as const) {
      expect(titles([owned, entry("Z user")], { sort })).toEqual(["Z user", "A extension"]);
    }
  });

  it("distinguishes identically named projects by full path and host", () => {
    const local = entry("Local");
    const otherPath = entry("Other path", {}, { workspaces: [{ id: "ws", path: "/archive/falcondeck" }] as TaskEntry["workspaces"] });
    const remote = entry("Remote", {}, { hostId: "server", hostName: "Build server" });
    expect(new Set([local, otherPath, remote].map((item) => automationProject(item).key)).size).toBe(3);
    expect(titles([local, remote, otherPath], { project: automationProject(remote).key })).toEqual(["Remote"]);
    expect(titles([local, remote], { host: "local", project: automationProject(remote).key })).toEqual([]);
  });

  it("finds control-owned project paths without a connected workspace", () => {
    const orphan = entry("Orphan", { workspace_id: "" }, {
      workspaces: [], automation: {
        target: { workspace_path: "/sites/lucidpic" },
        trigger: { kind: "interval", every_seconds: 3600 },
      } as Automation,
    });
    expect(automationProject(orphan).label).toBe("lucidpic");
    expect(titles([orphan], { query: "LUCIDPIC" })).toEqual(["Orphan"]);
  });

  it("matches every search term across names, prompts, agents, hosts, projects and cadence", () => {
    const remote = entry("Daily audit", {}, { hostId: "server", hostName: "Build server" });
    expect(titles([remote, entry("Other")], { query: "  AUDIT  billing server codex falcondeck 09:00 " })).toEqual(["Daily audit"]);
    expect(titles([remote], { query: "webhooks missing" })).toEqual([]);
    expect(titles([remote], { query: "   " })).toEqual(["Daily audit"]);
  });

  it("combines lifecycle and outcome filters, including failed automation states", () => {
    const entries = [
      entry("Failed run", { last_run: run("failed") }),
      entry("Waiting", { last_run: run("awaiting_input") }),
      entry("Queued", { last_run: run("queued") }),
      entry("Paused failure", { status: "paused" }, { automation: { state: "failed" } as Automation }),
      entry("Completed", { status: "completed" }),
    ];
    expect(titles(entries, { activity: "attention", sort: "name" })).toEqual(["Failed run", "Paused failure", "Waiting"]);
    expect(titles(entries, { status: "active", activity: "failed" })).toEqual(["Failed run"]);
    expect(titles(entries, { activity: "running" })).toEqual(["Queued"]);
    expect(titles(entries, { activity: "waiting" })).toEqual(["Waiting"]);
    expect(titles(entries, { status: "completed" })).toEqual(["Completed"]);
  });

  it("groups upcoming work by local calendar boundaries and keeps inactive schedules separate", () => {
    const now = new Date(2026, 9, 27, 9).getTime();
    const next = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    const entries = [
      entry("Next week", { next_run_at: next(8 * 1440) }),
      entry("Tomorrow", { next_run_at: new Date(2026, 9, 28, 0).toISOString() }),
      entry("No schedule", { next_run_at: "invalid" }),
      entry("Paused", { status: "paused", next_run_at: next(-60) }),
      entry("Completed", { status: "completed", next_run_at: next(10) }),
      entry("This week", { next_run_at: next(3 * 1440) }),
      entry("Later today", { next_run_at: next(60) }),
      entry("Soon", { next_run_at: next(30) }),
      entry("Due now", { next_run_at: next(0) }),
      entry("Missed", { next_run_at: next(-1) }),
      entry("Running", { next_run_at: next(-60), last_run: run("running") }),
      entry("Waiting", { last_run: run("awaiting_input") }),
    ];
    const groups = groupAutomationEntries(entries, "time", now);
    expect(groups.map((group) => [group.label, group.entries.map((item) => item.task.title)])).toEqual([
      ["In progress", ["Running", "Waiting"]],
      ["Overdue", ["Missed"]],
      ["Next hour", ["Soon", "Due now"]],
      ["Later today", ["Later today"]],
      ["Tomorrow", ["Tomorrow"]],
      ["Next 7 days", ["This week"]],
      ["Later", ["Next week"]],
      ["Not scheduled", ["No schedule"]],
      ["Paused", ["Paused"]],
      ["Completed", ["Completed"]],
    ]);
    expect(groups.flatMap((group) => group.entries)).toHaveLength(entries.length);
    expect(entries[0].task.title).toBe("Next week");
  });

  it("filters upcoming windows without including stale paused dates or running work as overdue", () => {
    const now = new Date(2026, 9, 27, 23, 30).getTime();
    const next = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    const entries = [
      entry("Overdue", { next_run_at: next(-1) }),
      entry("Soon", { next_run_at: next(10) }),
      entry("Tomorrow", { next_run_at: next(45) }),
      entry("In a day", { next_run_at: next(1440) }),
      entry("Paused", { status: "paused", next_run_at: next(10) }),
      entry("Running", { next_run_at: next(-10), last_run: run("running") }),
      entry("Invalid", { next_run_at: "invalid" }),
    ];
    const matching = (time: AutomationListFilters["time"]) => filterAutomationEntries(entries, { ...filters, time, sort: "name" }, "UTC", now).map((item) => item.task.title);
    expect(matching("hour")).toEqual(["Soon", "Tomorrow"]);
    expect(matching("today")).toEqual(["Overdue", "Running", "Soon"]);
    expect(matching("day")).toEqual(["Soon", "Tomorrow"]);
    expect(matching("week")).toEqual(["In a day", "Soon", "Tomorrow"]);
    expect(matching("overdue")).toEqual(["Overdue"]);
  });

  it("summarizes schedules and outcomes independently of lifecycle filters", () => {
    const now = Date.parse("2026-10-27T09:00:00Z");
    expect(summarizeAutomationEntries([
      entry("Due", { next_run_at: "2026-10-27T10:00:00Z" }),
      entry("Failed run", { last_run: run("failed") }),
      entry("Waiting", { last_run: run("awaiting_input") }),
      entry("Queued", { last_run: run("queued") }),
      entry("Paused failure", { status: "paused" }, { automation: { state: "failed" } as Automation }),
      entry("Completed", { status: "completed", next_run_at: "2026-10-27T10:00:00Z" }),
    ], now)).toEqual({ active: 4, due: 1, running: 1, attention: 3 });
  });

  it("keeps projects and hosts distinct, and extension records last in every grouping", () => {
    const local = entry("Local");
    const remote = entry("Remote", {}, { hostId: "server", hostName: "Build server" });
    const owned = entry("Owned", {}, { automation: { owner: { extension_id: "test", resource_id: "resource" } } as Automation });
    const entries = [owned, local, remote];
    const projects = groupAutomationEntries(entries, "project", Date.now());
    expect(projects).toHaveLength(3);
    expect(projects[0].key).not.toBe(projects[1].key);
    expect(projects[0].description).not.toBe(projects[1].description);
    expect(groupAutomationEntries(entries, "host", Date.now()).map((group) => group.label)).toEqual(["Build server", "This Mac", "Used by extensions"]);
    const flat = groupAutomationEntries(entries, "none", Date.now());
    expect(flat[0].label).toBeNull();
    expect(flat[0].entries).toEqual([local, remote]);
    for (const grouping of ["time", "project", "host", "none"] as const) {
      expect(groupAutomationEntries(entries, grouping, Date.now()).at(-1)?.entries).toEqual([owned]);
    }
  });
});
