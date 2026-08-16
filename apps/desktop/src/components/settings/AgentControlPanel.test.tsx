import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AgentControlPanel } from "./AgentControlPanel";

const onToast = vi.fn();

const settingsPayload = {
  enabled: true,
  providers: { codex: { enabled: true } },
  default_timezone: "Europe/London",
  allow_elevated_automations: false,
  confirmation_policy: { destructive_operations: true, sensitive_operations: true },
};

const auditPayload = [
  {
    id: "audit-1",
    occurred_at: "2026-08-16T14:22:10Z",
    context: { origin: "mcp", provider: "codex" },
    operation: "automation.create",
    result: "success",
    summary: "Created automation Weekday inbox review (automation-1)",
  },
];

function controlRoute(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function stubFetch() {
  const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = url.replace("http://daemon.test", "");
    if (route === "/api/control/get") {
      // The panel reads settings and audit with the same route; the test
      // inspects the request body to decide which payload to return.
      return controlRoute({ resource: "x", data: null });
    }
    return controlRoute({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubControlFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace("http://daemon.test", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    if (url === "/api/control/get" && body.resource === "agent_control.settings") {
      return controlRoute({ resource: "agent_control.settings", data: settingsPayload });
    }
    if (url === "/api/control/get" && body.resource === "control.audit") {
      return controlRoute({ resource: "control.audit", data: auditPayload });
    }
    if (url === "/api/control/execute") {
      return controlRoute({
        ok: true,
        operation: body.operation,
        data: { ...settingsPayload, enabled: false },
      });
    }
    return controlRoute({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

beforeEach(() => {
  onToast.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentControlPanel", () => {
  it("renders settings toggle state and provider overrides", async () => {
    stubControlFetch();
    render(<AgentControlPanel baseUrl="http://daemon.test" onToast={onToast} />);

    await waitFor(() => {
      expect(screen.getByText("Agent control enabled")).toBeTruthy();
    });
    // The codex override is rendered with its own toggle; claude inherits.
    expect(screen.getByLabelText("Toggle agent control for codex")).toBeTruthy();
    expect(screen.getByLabelText("Toggle agent control for claude")).toBeTruthy();
    expect(screen.getByText("Explicit provider override")).toBeTruthy();
    expect(screen.getByText("Inherits the global setting")).toBeTruthy();
    // Recent changes list renders with origin detail.
    expect(
      screen.getByText("Created automation Weekday inbox review (automation-1)"),
    ).toBeTruthy();
    expect(screen.getByText(/mcp · codex/)).toBeTruthy();
  });

  it("sends the global toggle through the control execute route", async () => {
    const { calls } = stubControlFetch();
    const { user } = await renderPanel();
    void user;

    const toggle = await screen.findByRole("button", { name: /enabled/i });
    fireEvent.click(toggle);
    await waitFor(() => {
      const execute = calls.find((call) => call.url === "/api/control/execute");
      expect(execute?.body).toMatchObject({
        operation: "agent_control.settings.update",
        arguments: { enabled: false },
      });
    });
    expect(onToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "success" }),
    );
  });

  it("sends provider overrides including existing entries", async () => {
    const { calls } = stubControlFetch();
    render(<AgentControlPanel baseUrl="http://daemon.test" onToast={onToast} />);
    const codexToggle = await screen.findByLabelText("Toggle agent control for codex");
    fireEvent.click(codexToggle);
    await waitFor(() => {
      const execute = calls.find((call) => call.url === "/api/control/execute");
      expect(execute?.body).toMatchObject({
        operation: "agent_control.settings.update",
        arguments: {
          providers: { codex: { enabled: false } },
        },
      });
    });
  });

  it("renders and sends confirmation preferences", async () => {
    const { calls } = stubControlFetch();
    render(<AgentControlPanel baseUrl="http://daemon.test" onToast={onToast} />);
    const destructive = await screen.findByRole("button", {
      name: "Confirm destructive operations",
    });
    expect(destructive.textContent).toContain("Asking");
    fireEvent.click(destructive);
    await waitFor(() => {
      const execute = calls.find((call) => call.url === "/api/control/execute");
      expect(execute?.body).toMatchObject({
        operation: "agent_control.settings.update",
        arguments: {
          confirmation_policy: {
            destructive_operations: false,
            sensitive_operations: true,
          },
        },
      });
    });
  });

  it("shows structured errors from the daemon", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input).replace("http://daemon.test", "");
      if (url === "/api/control/get") {
        return controlRoute({ resource: "agent_control.settings", data: settingsPayload });
      }
      return controlRoute({
        ok: false,
        operation: "agent_control.settings.update",
        error: {
          code: "invalid_timezone",
          message: "Timezone 'London' is not an IANA timezone identifier.",
          retryable: true,
          field_errors: [],
          suggested_action: "Retry with an IANA timezone identifier.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentControlPanel baseUrl="http://daemon.test" onToast={onToast} />);
    fireEvent.change(await screen.findByLabelText("Default timezone"), {
      target: { value: "London" },
    });
    const save = await screen.findByRole("button", { name: "Save" });
    await waitFor(() => expect(save.getAttribute("disabled")).toBeNull());
    fireEvent.click(save);
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "danger",
          description: "Retry with an IANA timezone identifier.",
        }),
      );
    });
  });
});

async function renderPanel() {
  render(<AgentControlPanel baseUrl="http://daemon.test" onToast={onToast} />);
  await screen.findByText("Agent control enabled");
  return { user: null };
}

describe("AgentControlPanel fallbacks", () => {
  it("surfaces load errors with a retry button", async () => {
    stubFetch();
    const failing = vi.fn<typeof fetch>(async () =>
      Promise.reject(new Error("daemon offline")),
    );
    vi.stubGlobal("fetch", failing);
    render(<AgentControlPanel baseUrl="http://daemon.test" onToast={onToast} />);
    await waitFor(() => {
      expect(screen.getByText("daemon offline")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
