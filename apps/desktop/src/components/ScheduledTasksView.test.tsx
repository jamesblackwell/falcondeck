import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  Automation,
  DaemonSnapshot,
} from "@falcondeck/client-core";

import type { HostManager, HostScopedApi, HostView } from "../hosts";
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

function setup(
  apiOverrides: Partial<HostScopedApi> = {},
  onCreateWithAgent: ReturnType<typeof vi.fn> | null = vi.fn(),
  hosts: HostView[] = [],
) {
  const runScheduledTask = vi.fn().mockResolvedValue({});
  const createScheduledTask = vi.fn().mockResolvedValue({});
  const scheduledTask = vi.fn().mockResolvedValue({
    ...snapshot.scheduled_tasks?.[0],
    prompt: "Summarize yesterday’s changes",
    isolation: "project_folder",
    selected_skills: [],
    created_at: "2026-08-13T08:00:00Z",
  });
  const scheduledTaskRuns = vi.fn().mockResolvedValue([]);
  // Legacy-only tests do not need the asynchronous control projection. Keep
  // it pending so those synchronous assertions do not race an unrelated
  // effect; automation tests provide a resolved override and await it.
  const controlGet = vi.fn().mockReturnValue(new Promise(() => {}));
  const controlExecute = vi.fn().mockResolvedValue({
    ok: true,
    operation: "automation.run_now",
    data: {},
  });
  const localApi = {
    runScheduledTask,
    createScheduledTask,
    scheduledTask,
    scheduledTaskRuns,
    updateScheduledTask: vi.fn().mockResolvedValue({}),
    deleteScheduledTask: vi.fn().mockResolvedValue({ ok: true }),
    controlGet,
    controlExecute,
    ...apiOverrides,
  } as unknown as HostScopedApi;
  const onRefreshLocal = vi.fn().mockResolvedValue(undefined);
  render(
    <ScheduledTasksView
      localSnapshot={snapshot}
      localApi={localApi}
      localBaseUrl="http://daemon.test"
      hosts={hosts}
      manager={{ connection: () => null } as unknown as HostManager}
      onRefreshLocal={onRefreshLocal}
      onCreateWithAgent={onCreateWithAgent ?? undefined}
      onOpenThread={vi.fn()}
      onToast={vi.fn()}
    />,
  );
  return {
    runScheduledTask,
    createScheduledTask,
    onRefreshLocal,
    scheduledTask,
    controlGet,
    controlExecute,
    onCreateWithAgent,
  };
}

const conversationalAutomation = {
  id: "automation-runpod-midday",
  revision: 3,
  name: "Alert if ComfyUI is running at midday",
  state: "enabled",
  trigger: {
    kind: "cron",
    expression: "0 12 * * *",
    timezone: "Europe/London",
  },
  target: {
    workspace_path: "/Users/james/falcondeck",
    provider: "codex",
  },
  elevated: false,
  required_connectors: [],
  concurrency_policy: "skip",
  misfire_policy: "skip",
  next_run_at: "2026-08-14T11:00:00Z",
  updated_at: "2026-08-13T08:00:00Z",
  resolved_schedule: "At 12:00 daily (Europe/London)",
} as unknown as Automation;

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
    fireEvent.change(screen.getByPlaceholderText("Search automations"), {
      target: { value: "briefing" },
    });
    expect(screen.getByText("Daily briefing")).toBeInTheDocument();
    expect(screen.queryByText("Paused audit")).not.toBeInTheDocument();
  });

  it("uses the shared compact host picker when servers are enrolled", () => {
    setup({}, vi.fn(), [
      {
        id: "host-build-server",
        name: "Build server",
        sshTarget: "build-server",
        sshPort: 22,
        relayUrl: "wss://connect.falcondeck.com",
        enabled: true,
        paired: true,
        needsRepair: false,
        status: "offline",
        presence: null,
        snapshot: null,
        lastError: null,
      },
    ]);

    const hostFilter = screen.getByRole("combobox", {
      name: "Filter scheduled tasks by host",
    });
    expect(hostFilter).toHaveTextContent("All hosts");

    fireEvent.click(hostFilter);
    expect(
      screen.getByRole("option", { name: /All hosts/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Build server/i }),
    ).toBeInTheDocument();
  });

  it("shows conversational automations beside legacy scheduled tasks", async () => {
    setup({
      controlGet: vi.fn().mockResolvedValue({
        resource: "automations",
        data: [conversationalAutomation],
      }),
    });

    expect(screen.getByText("Daily briefing")).toBeInTheDocument();
    expect(
      await screen.findByText("Alert if ComfyUI is running at midday"),
    ).toBeInTheDocument();
  });

  it("routes automation actions to the owning control service", async () => {
    const controlExecute = vi.fn().mockResolvedValue({
      ok: true,
      operation: "automation.run_now",
      data: {},
    });
    setup({
      controlGet: vi.fn().mockResolvedValue({
        resource: "automations",
        data: [conversationalAutomation],
      }),
      controlExecute,
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Run Alert if ComfyUI is running at midday now",
      }),
    );

    await waitFor(() =>
      expect(controlExecute).toHaveBeenCalledWith({
        operation: "automation.run_now",
        arguments: { automation_id: conversationalAutomation.id },
      }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Pause Alert if ComfyUI is running at midday",
      }),
    );
    await waitFor(() =>
      expect(controlExecute).toHaveBeenCalledWith({
        operation: "automation.pause",
        arguments: { automation_id: conversationalAutomation.id },
        expected_revision: conversationalAutomation.revision,
      }),
    );
  });

  it("loads conditional prompts and control-owned run history on demand", async () => {
    const fullAutomation = {
      ...conversationalAutomation,
      description: "Only alert when action is needed",
      task: {
        kind: "conditional_prompt",
        instruction: "Check whether the RunPod workstation is still running.",
        no_action_marker: "FALCONDECK_NO_ACTION",
      },
      target: {
        ...conversationalAutomation.target,
        thread: { kind: "managed", thread_id: "thread-managed" },
        permission_mode: "never",
        sandbox_mode: "workspace-write",
        isolation: "project_folder",
        selected_skills: ["ntfy"],
      },
      created_at: "2026-08-13T08:00:00Z",
    } as unknown as Automation;
    const controlGet = vi.fn().mockImplementation((request) => {
      if (request.resource === "automations") {
        return Promise.resolve({ resource: "automations", data: [conversationalAutomation] });
      }
      if (request.resource === "automation") {
        return Promise.resolve({ resource: "automation", data: fullAutomation });
      }
      if (request.resource === "automation.runs") {
        return Promise.resolve({
          resource: "automation.runs",
          data: [
            {
              id: "run-control-1",
              automation_id: fullAutomation.id,
              automation_name: fullAutomation.name,
              automation_revision: fullAutomation.revision,
              status: "succeeded_no_action",
              trigger: "scheduled",
              queued_at: "2026-08-13T11:00:00Z",
              finished_at: "2026-08-13T11:00:04Z",
              runtime_workspace_id: "workspace-1",
              thread_id: "thread-run-1",
              outcome_preview: "FALCONDECK_NO_ACTION",
            },
          ],
        });
      }
      return Promise.resolve({ resource: request.resource, data: {} });
    });
    setup({ controlGet });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open Alert if ComfyUI is running at midday",
      }),
    );

    expect(
      await screen.findByText(
        "Check whether the RunPod workstation is still running.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No-action marker: FALCONDECK_NO_ACTION"),
    ).toBeInTheDocument();
    expect(screen.getByText("succeeded no action")).toBeInTheDocument();
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

  it("opens a new agent conversation from the primary action", () => {
    const { onCreateWithAgent } = setup();
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));
    expect(onCreateWithAgent).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("heading", { name: "New automation" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the manual creation sheet in the task options menu", () => {
    setup();
    const options = screen.getByRole("button", {
      name: "New automation options",
    });
    expect(options).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(options);
    expect(
      screen.getByRole("menuitem", { name: "Create with agent" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Set up manually" }));
    expect(
      screen.getByRole("heading", { name: "New automation" }),
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

  it("creates manual tasks in the canonical automation store", async () => {
    const { controlExecute, createScheduledTask } = setup();
    fireEvent.click(
      screen.getByRole("button", { name: "New automation options" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Set up manually" }));
    fireEvent.change(screen.getByPlaceholderText("Automation name"), {
      target: { value: "Canonical daily task" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Describe what the agent should do"),
      { target: { value: "Check the canonical scheduler." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));

    await waitFor(() =>
      expect(controlExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "automation.create",
          arguments: expect.objectContaining({
            name: "Canonical daily task",
            task: {
              kind: "prompt",
              instruction: "Check the canonical scheduler.",
            },
            target: expect.objectContaining({
              workspace_path: "/Users/james/falcondeck",
              provider: "codex",
            }),
          }),
        }),
      ),
    );
    expect(createScheduledTask).not.toHaveBeenCalled();
  });

  it("focuses the enabled manual option when agent creation is unavailable", () => {
    setup({}, null);
    fireEvent.click(
      screen.getByRole("button", { name: "New automation options" }),
    );

    expect(
      screen.getByRole("menuitem", { name: "Set up manually" }),
    ).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("searches prompt previews and exposes a keyboard-accessible action menu", () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText("Search automations"), {
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
