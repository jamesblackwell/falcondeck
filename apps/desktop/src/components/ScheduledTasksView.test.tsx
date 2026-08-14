import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DaemonSnapshot } from "@falcondeck/client-core";

import type { HostManager, HostScopedApi } from "../hosts";
import { ScheduledTasksView } from "./ScheduledTasksView";
import { utcToWallTime, wallTimeToUtc } from "../scheduled-time";

const snapshot = {
  daemon: {
    version: "0.1.0",
    started_at: "2026-08-13T08:00:00Z",
    capabilities: { scheduled_tasks: true },
  },
  workspaces: [
    {
      id: "workspace-1",
      path: "/Users/james/falcondeck",
      status: "ready",
      agents: [{ provider: "codex", label: "Codex" }],
      default_provider: "codex",
    },
  ],
  threads: [],
  interactive_requests: [],
  preferences: {},
  extensions: { catalog: [], views: [] },
  scheduled_tasks: [
    {
      id: "scheduled-1",
      title: "Daily briefing",
      prompt_preview: "Summarize yesterday’s changes",
      status: "active",
      schedule: {
        kind: "recurring",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        timezone: "Europe/London",
      },
      workspace_id: "workspace-1",
      provider: "codex",
      next_run_at: "2026-08-14T08:00:00Z",
      updated_at: "2026-08-13T08:00:00Z",
    },
    {
      id: "scheduled-2",
      title: "Paused audit",
      prompt_preview: "Check the release permissions",
      status: "paused",
      schedule: {
        kind: "recurring",
        rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
        timezone: "Europe/London",
      },
      workspace_id: "workspace-1",
      provider: "codex",
      updated_at: "2026-08-13T08:00:00Z",
    },
  ],
} as unknown as DaemonSnapshot;

function setup(apiOverrides: Partial<HostScopedApi> = {}) {
  const runScheduledTask = vi.fn().mockResolvedValue({});
  const scheduledTask = vi.fn().mockResolvedValue({
    ...snapshot.scheduled_tasks?.[0],
    prompt: "Summarize yesterday’s changes",
    isolation: "project_folder",
    selected_skills: [],
    created_at: "2026-08-13T08:00:00Z",
  });
  const scheduledTaskRuns = vi.fn().mockResolvedValue([]);
  const localApi = {
    runScheduledTask,
    scheduledTask,
    scheduledTaskRuns,
    updateScheduledTask: vi.fn().mockResolvedValue({}),
    deleteScheduledTask: vi.fn().mockResolvedValue({ ok: true }),
    ...apiOverrides,
  } as unknown as HostScopedApi;
  const onRefreshLocal = vi.fn().mockResolvedValue(undefined);
  render(
    <ScheduledTasksView
      localSnapshot={snapshot}
      localApi={localApi}
      hosts={[]}
      manager={{ connection: () => null } as unknown as HostManager}
      onRefreshLocal={onRefreshLocal}
      onOpenThread={vi.fn()}
      onToast={vi.fn()}
    />,
  );
  return { runScheduledTask, onRefreshLocal, scheduledTask };
}

describe("ScheduledTasksView", () => {
  it("converts one-time wall clocks using the selected IANA timezone", () => {
    expect(wallTimeToUtc("2026-08-13T09:00", "Europe/London")).toBe(
      "2026-08-13T08:00:00.000Z",
    );
    expect(
      utcToWallTime(new Date("2026-08-13T08:00:00Z"), "Europe/London"),
    ).toBe("2026-08-13T09:00");
    expect(() => wallTimeToUtc("2026-03-29T01:30", "Europe/London")).toThrow(
      "does not exist",
    );
  });

  it("searches and filters daemon-owned tasks", () => {
    setup();
    expect(screen.getByText("Daily briefing")).toBeInTheDocument();
    expect(screen.getByText("Paused audit")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^paused$/i }));
    expect(screen.queryByText("Daily briefing")).not.toBeInTheDocument();
    expect(screen.getByText("Paused audit")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^all$/i }));
    fireEvent.change(screen.getByPlaceholderText("Search scheduled tasks"), {
      target: { value: "briefing" },
    });
    expect(screen.getByText("Daily briefing")).toBeInTheDocument();
    expect(screen.queryByText("Paused audit")).not.toBeInTheDocument();
  });

  it("runs a task on its owning daemon and refreshes the local snapshot", async () => {
    const { runScheduledTask, onRefreshLocal } = setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Run Daily briefing now" }),
    );

    await waitFor(() =>
      expect(runScheduledTask).toHaveBeenCalledWith("scheduled-1"),
    );
    expect(onRefreshLocal).toHaveBeenCalledOnce();
  });

  it("opens the task creation sheet from the primary action", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(
      screen.getByRole("heading", { name: "New scheduled task" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Execution host")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toBeInTheDocument();
    expect(screen.getByLabelText("Repeat")).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.queryByLabelText("Timezone")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByLabelText("Timezone")).toBeInTheDocument();
    expect(screen.getByLabelText("Checkout")).toBeInTheDocument();
  });

  it("searches prompt previews and exposes a keyboard-accessible action menu", () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText("Search scheduled tasks"), {
      target: { value: "release permissions" },
    });
    expect(screen.getByText("Paused audit")).toBeInTheDocument();
    expect(screen.queryByText("Daily briefing")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Paused audit" }),
    );
    expect(
      screen.getByRole("menu", { name: "Actions for Paused audit" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Resume" }),
    ).toBeInTheDocument();
  });

  it("loads the prompt and run history in the detail panel", async () => {
    setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Daily briefing" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Daily briefing" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText("Summarize yesterday’s changes"),
      ).toBeInTheDocument(),
    );
  });

  it("does not show details from a previously selected task", async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    const scheduledTask = vi.fn(
      (taskId: string) =>
        new Promise((resolve) => {
          resolvers.set(taskId, resolve);
        }),
    );
    setup({ scheduledTask } as Partial<HostScopedApi>);

    fireEvent.click(
      screen.getByRole("button", { name: "Open Daily briefing" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Paused audit" }));

    resolvers.get("scheduled-2")?.({
      ...snapshot.scheduled_tasks?.[1],
      prompt: "Paused task detail",
      isolation: "project_folder",
      selected_skills: [],
      created_at: "2026-08-13T08:00:00Z",
    });
    await waitFor(() =>
      expect(screen.getByText("Paused task detail")).toBeInTheDocument(),
    );

    resolvers.get("scheduled-1")?.({
      ...snapshot.scheduled_tasks?.[0],
      prompt: "Stale daily detail",
      isolation: "project_folder",
      selected_skills: [],
      created_at: "2026-08-13T08:00:00Z",
    });
    await Promise.resolve();

    expect(screen.queryByText("Stale daily detail")).not.toBeInTheDocument();
    expect(screen.getByText("Paused task detail")).toBeInTheDocument();
  });
});
