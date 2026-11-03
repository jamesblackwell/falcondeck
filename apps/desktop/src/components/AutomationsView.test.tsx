import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { AgentControlSettings, Automation } from "@falcondeck/client-core";

import { AutomationEditor, AutomationsView } from "./AutomationsView";

import { automationDraftFrom } from "./automation-draft";

const onToast = vi.fn();

const settings: AgentControlSettings = {
  enabled: true,
  providers: {},
  default_timezone: "Europe/London",
  allow_elevated_automations: false,
  confirmation_policy: { destructive_operations: true, sensitive_operations: true },
};

const automation: Automation = {
  id: "automation-1",
  revision: 4,
  name: "Weekday inbox review",
  trigger: { kind: "cron", expression: "0 8 * * 1-5", timezone: "Europe/London" },
  task: {
    kind: "conditional_prompt",
    instruction: "Review my inbox.",
    no_action_marker: "FALCONDECK_NO_ACTION",
  },
  target: {
    workspace_path: "/Users/james/Code/quizgecko",
    provider: "codex",
    thread: { kind: "managed", thread_id: "thread-9" },
    selected_skills: ["inbox-triage"],
  },
  state: "enabled",
  concurrency_policy: "skip",
  misfire_policy: "skip",
  elevated: false,
  required_connectors: [],
  created_at: "2026-08-16T14:00:00Z",
  updated_at: "2026-08-16T14:22:10Z",
  next_run_at: "2026-08-17T07:00:00Z",
  last_run_at: null,
  latest_outcome: null,
  resolved_schedule: 'cron "0 8 * * 1-5" (Europe/London)',
};

type ExecuteCall = { operation: string; expected_revision?: number; arguments: Record<string, unknown> };

function stubControl(options?: { executeResponse?: unknown; automation?: Automation }) {
  const row = options?.automation ?? automation;
  const executeCalls: ExecuteCall[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace("http://daemon.test", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      });
    if (url === "/api/control/get" && body.resource === "agent_control.settings") {
      return json({ resource: "agent_control.settings", data: settings });
    }
    if (url === "/api/control/get" && body.resource === "automations") {
      return json({ resource: "automations", data: [row] });
    }
    if (url === "/api/control/get" && body.resource === "automation") {
      return json({ resource: "automation", data: row });
    }
    if (url === "/api/control/get" && body.resource === "automation.runs") {
      return json({
        resource: "automation.runs",
        data: [
          {
            id: "run-1",
            automation_id: "automation-1",
            automation_name: "Weekday inbox review",
            automation_revision: 4,
            status: "succeeded_no_action",
            queued_at: "2026-08-17T07:00:01Z",
            outcome_preview: "FALCONDECK_NO_ACTION",
          },
        ],
      });
    }
    if (url === "/api/control/execute") {
      executeCalls.push({
        operation: String(body.operation),
        ...(body.expected_revision === undefined
          ? {}
          : { expected_revision: body.expected_revision as number }),
        arguments: body.arguments as Record<string, unknown>,
      });
      return json(
        options?.executeResponse ?? {
          ok: true,
          operation: body.operation,
          data: { id: "automation-1", revision: 5 },
        },
      );
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { executeCalls, fetchMock };
}

beforeEach(() => {
  onToast.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderView() {
  render(<AutomationsView baseUrl="http://daemon.test" onToast={onToast} />);
  await screen.findByText("Weekday inbox review");
}

describe("AutomationsView list", () => {
  it("renders automation rows with schedule, provider, next run and state", async () => {
    stubControl();
    await renderView();
    expect(screen.getByText("enabled")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText(/Weekdays at 08:00/)).toBeTruthy();
    expect(screen.getByText(/Overdue|in \d+|tomorrow|Not scheduled/)).toBeTruthy();
    // The instruction never renders in the list.
    expect(screen.queryByText("Review my inbox.")).toBeNull();
  });

  it("pauses with the current revision and shows conflict feedback on stale edits", async () => {
    const { executeCalls, fetchMock } = stubControl({
      executeResponse: {
        ok: false,
        operation: "automation.pause",
        error: {
          code: "revision_conflict",
          message: "Automation automation-1 changed after it was read.",
          retryable: true,
          field_errors: [],
          current_revision: 7,
          suggested_action: "Read the automation again and retry with expected_revision 7.",
        },
      },
    });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    await waitFor(() => {
      expect(executeCalls).toContainEqual({
        operation: "automation.pause",
        expected_revision: 4,
        arguments: { automation_id: "automation-1" },
      });
    });
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "danger",
          title: "This automation changed elsewhere",
          description: "Read the automation again and retry with expected_revision 7.",
        }),
      );
    });
    // A conflict triggers a refetch of the authoritative list.
    await waitFor(() => {
      const listReads = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/api/control/get"),
      );
      expect(listReads.length).toBeGreaterThan(1);
    });
  });

  it("runs now without a revision and deletes after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { executeCalls } = stubControl();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => {
      expect(executeCalls).toContainEqual({
        operation: "automation.run_now",
        expected_revision: undefined,
        arguments: { automation_id: "automation-1" },
      });
    });
    fireEvent.click(screen.getByLabelText("Delete Weekday inbox review"));
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
      expect(executeCalls).toContainEqual({
        operation: "automation.delete",
        expected_revision: 4,
        arguments: { automation_id: "automation-1" },
      });
    });
  });

  it("refuses to delete without confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { executeCalls } = stubControl();
    await renderView();
    fireEvent.click(screen.getByLabelText("Delete Weekday inbox review"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(
      executeCalls.filter((call) => call.operation === "automation.delete"),
    ).toHaveLength(0);
  });

  it("shows run history with terminal previews", async () => {
    stubControl();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => {
      expect(screen.getByText("succeeded_no_action")).toBeTruthy();
      expect(screen.getByText("FALCONDECK_NO_ACTION")).toBeTruthy();
    });
  });

  it("refetches when a control-state event arrives", async () => {
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket {
      onmessage: ((message: { data: string }) => void) | null = null;
      constructor(public url: string) {
        sockets.push(this);
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { fetchMock } = stubControl();
    render(<AutomationsView baseUrl="http://daemon.test" onToast={onToast} />);
    await screen.findByText("Weekday inbox review");
    await waitFor(() => expect(sockets).toHaveLength(1));
    const listReadsBefore = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/api/control/get"),
    ).length;

    // An MCP-originated change emits control-state-changed on the daemon's
    // event stream; the open panel must refetch without any interaction.
    act(() => {
      sockets[0].onmessage?.({
        data: JSON.stringify({
          seq: 1,
          emitted_at: "2026-08-16T14:22:10Z",
          workspace_id: null,
          thread_id: null,
          event: {
            type: "control-state-changed",
            change: { store_revision: 43, domains: ["automations"] },
          },
        }),
      });
    });
    await waitFor(() => {
      const listReads = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/api/control/get"),
      );
      expect(listReads.length).toBeGreaterThan(listReadsBefore);
    });
  });
});

describe("AutomationsView editor", () => {
  it("validates create-form input before anything is sent", async () => {
    const { executeCalls } = stubControl();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));
    const submit = screen.getByRole("button", { name: "Create automation" });
    expect(submit.getAttribute("disabled")).not.toBeNull();
    // The daemon never sees invalid input: nothing is sent while required
    // fields are empty.
    expect(executeCalls).toHaveLength(0);
  });

  it("creates an automation with the shared control payload", async () => {
    const { executeCalls } = stubControl();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));
    fireEvent.change(screen.getByLabelText("Automation name"), {
      target: { value: "Deploy watchdog" },
    });
    fireEvent.change(screen.getByLabelText("Automation instruction"), {
      target: { value: "Check deployments." },
    });
    fireEvent.change(screen.getByLabelText("Workspace path"), {
      target: { value: "/Users/james/Code/ops" },
    });

    const submit = screen.getByRole("button", { name: "Create automation" });
    await waitFor(() => expect(submit.getAttribute("disabled")).toBeNull());
    fireEvent.click(submit);
    await waitFor(() => {
      expect(executeCalls).toHaveLength(1);
      expect(executeCalls[0].operation).toBe("automation.create");
      expect(executeCalls[0].arguments).toMatchObject({
        name: "Deploy watchdog",
        task: { kind: "prompt", instruction: "Check deployments." },
        target: {
          workspace_path: "/Users/james/Code/ops",
          provider: "codex",
        },
        trigger: {
          kind: "cron",
          expression: "0 8 * * 1-5",
          timezone: "Europe/London",
        },
      });
    });
  });

  it("shows a stored grok provider instead of falling back to codex", async () => {
    stubControl({
      automation: {
        ...automation,
        target: {
          ...automation.target,
          provider: "grok",
          thread: { kind: "managed", thread_id: "grok-thread-abc" },
        },
      },
    });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Edit automation");
    const provider = screen.getByLabelText("Provider") as HTMLSelectElement;
    await waitFor(() => expect(provider.value).toBe("grok"));
    expect([...provider.options].map((option) => option.value)).toEqual(
      expect.arrayContaining(["codex", "claude", "grok", "agy"]),
    );
    expect(screen.getByLabelText("Thread id")).toHaveValue("grok-thread-abc");
  });

  it("clears the managed thread when the provider changes", async () => {
    const { executeCalls } = stubControl({
      automation: {
        ...automation,
        target: {
          ...automation.target,
          provider: "grok",
          thread: { kind: "managed", thread_id: "grok-thread-abc" },
        },
      },
    });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Edit automation");
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "codex" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const update = executeCalls.find(
        (call) => call.operation === "automation.update",
      );
      expect(update?.arguments).toMatchObject({
        target: {
          provider: "codex",
          thread: { kind: "managed" },
        },
      });
      expect(
        (update?.arguments.target as { thread?: { thread_id?: string } })
          .thread?.thread_id,
      ).toBeUndefined();
    });
  });

  it("edits preserve the stored thread, skills and schedule anchor", async () => {
    const { executeCalls } = stubControl();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Edit automation");
    const name = screen.getByLabelText("Automation name");
    await waitFor(() => expect((name as HTMLInputElement).value).toBe("Weekday inbox review"));
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const update = executeCalls.find(
        (call) => call.operation === "automation.update",
      );
      expect(update?.expected_revision).toBe(4);
      expect(update?.arguments).toMatchObject({
        automation_id: "automation-1",
        name: "Renamed",
        target: {
          thread: { kind: "managed", thread_id: "thread-9" },
          selected_skills: ["inbox-triage"],
        },
      });
    });
  });

  it("edits submit the loaded revision", async () => {
    const { executeCalls } = stubControl();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Edit automation");
    const name = screen.getByLabelText("Automation name");
    await waitFor(() => expect((name as HTMLInputElement).value).toBe("Weekday inbox review"));
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const update = executeCalls.find(
        (call) => call.operation === "automation.update",
      );
      expect(update?.expected_revision).toBe(4);
      expect(update?.arguments).toMatchObject({
        automation_id: "automation-1",
        name: "Renamed",
      });
    });
  });

  it("warns when an elevated mode is selected and elevated automations are disabled", async () => {
    stubControl();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));
    fireEvent.change(screen.getByLabelText("Permission mode"), {
      target: { value: "bypassPermissions" },
    });
    expect(await screen.findByText(/Elevated authority/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Create automation" });
    expect(submit.getAttribute("disabled")).not.toBeNull();
  });
});

it("loads daemon cadence advice and preserves the window in its one-click fix", async () => {
  const window = { timezone: "Europe/London", start_minute: 480, end_minute: 1020, weekdays: [1,2,3,4,5] };
  const loadAdvice = vi.fn().mockResolvedValue([{ code: "cache_cold_reuse", message: "Cold cache risk", suggested_action: "Use 50 minutes", suggested_interval_seconds: 3000, replacement_trigger: { kind: "interval", every_seconds: 3000, anchor_at: "2026-11-03T08:00:00Z", active_window: window } }]);
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<AutomationEditor state={{ kind: "edit", id: automation.id, revision: 4, draft: { ...automationDraftFrom(automation), provider: "claude" } }} loadAdvice={loadAdvice} allowElevated onCancel={() => {}} onSubmit={submit} />);
  fireEvent.click(await screen.findByRole("button", { name: "Use 50 min" }));
  expect(screen.getByLabelText("Interval seconds")).toHaveValue("3000");
  expect(screen.getByLabelText("Window end minute")).toHaveValue(1020);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ scheduleKind: "interval", activeWindow: window }), true));
});

it("requires a separate approval click on the displayed saved command", async () => {
  const approve = vi.fn().mockResolvedValue(undefined);
  const draft = { ...automationDraftFrom(automation), precheckCommand: "echo reviewed", precheckTimeout: "5", precheckApprovalHash: "displayed-hash", precheckWorkspace: "/private/tmp" };
  render(<AutomationEditor state={{kind: "edit", id: automation.id, revision: 4, draft}} allowElevated onCancel={() => {}} onSubmit={vi.fn()} onApprovePrecheck={approve} />);
  expect(screen.getByText("echo reviewed", { selector: "pre" })).toBeInTheDocument();
  expect(approve).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Pre-check command"), {target: {value: "echo changed"}});
  expect(screen.getByRole("button", {name: "Approve pre-check"})).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Pre-check command"), {target: {value: "echo reviewed"}});
  fireEvent.click(screen.getByRole("button", {name: "Approve pre-check"}));
  await waitFor(() => expect(approve).toHaveBeenCalledWith("displayed-hash"));
});
