import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ComputerUsePanel } from "./ComputerUsePanel";

const api = vi.hoisted(() => ({
  computerUse: vi.fn(),
  updateComputerUse: vi.fn(),
  openAgentBrowser: vi.fn(),
}));

vi.mock("@falcondeck/client-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@falcondeck/client-core")>(),
  createDaemonApiClient: () => api,
}));
vi.mock("../ComputerUseSetup", () => ({ ComputerUseSetup: () => null }));

const cuaStatus = {
  backend: "cua_driver",
  agent_desktop_binary_present: true,
  available: true,
  macos_ok: true,
  binary_present: true,
  enabled: false,
  overlay: true,
  telemetry: false,
  existing_profile: false,
};

async function chooseBackend(name: string) {
  const selector = screen.getByRole("combobox", { name: "Computer-use backend" });
  await waitFor(() => expect(selector).toBeEnabled());
  fireEvent.click(selector);
  await act(async () => {
    fireEvent.click(screen.getByRole("option", { name }));
  });
}

describe("computer-use backend", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.computerUse.mockResolvedValue(cuaStatus);
    api.updateComputerUse.mockImplementation(async (update) => ({ ...cuaStatus, ...update }));
  });

  it("changes the backend without granting computer-use consent", async () => {
    render(<ComputerUsePanel baseUrl="http://localhost:1" onToast={() => {}} />);

    await chooseBackend("agent-desktop (Experimental)");

    await waitFor(() => {
      expect(api.updateComputerUse).toHaveBeenCalledWith({ backend: "agent_desktop" });
      expect(screen.getByRole("combobox", { name: "Computer-use backend" }))
        .toHaveTextContent("agent-desktop (Experimental)");
    });
    expect(screen.getByRole("switch", { name: "Allow agents to use this Mac" })).not.toBeChecked();
    expect(screen.queryByRole("switch", { name: "Show the agent cursor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Share anonymous driver telemetry with Cua" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Allow agents to use my personal Chrome profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open agent browser" })).not.toBeInTheDocument();
  });

  it("allows switching back when agent-desktop is not installed", async () => {
    api.computerUse.mockResolvedValue({
      ...cuaStatus,
      backend: "agent_desktop",
      binary_present: false,
      agent_desktop_binary_present: false,
    });
    render(<ComputerUsePanel baseUrl="http://localhost:1" onToast={() => {}} />);

    expect(await screen.findByText("npm install -g agent-desktop")).toBeInTheDocument();
    await chooseBackend("Cua Driver");

    await waitFor(() => {
      expect(api.updateComputerUse).toHaveBeenCalledWith({ backend: "cua_driver" });
      expect(screen.getByRole("switch", { name: "Show the agent cursor" })).toBeInTheDocument();
    });
  });

  it("keeps backend selection disabled for an older daemon", async () => {
    api.computerUse.mockResolvedValue({ ...cuaStatus, backend: undefined });
    render(<ComputerUsePanel baseUrl="http://localhost:1" onToast={() => {}} />);

    const selector = await screen.findByRole("combobox", { name: "Computer-use backend" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show the agent cursor" })).toBeChecked());
    expect(selector).toBeDisabled();
    expect(selector).toHaveTextContent("Cua Driver");
    expect(api.updateComputerUse).not.toHaveBeenCalled();
  });

  it("keeps the selected backend when saving fails", async () => {
    const onToast = vi.fn();
    api.updateComputerUse.mockRejectedValue(new Error("Could not save preferences"));
    render(<ComputerUsePanel baseUrl="http://localhost:1" onToast={onToast} />);

    await chooseBackend("agent-desktop (Experimental)");

    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.objectContaining({
      variant: "danger",
      description: "Could not save preferences",
    })));
    expect(screen.getByRole("combobox", { name: "Computer-use backend" })).toHaveTextContent("Cua Driver");
    expect(screen.getByRole("switch", { name: "Show the agent cursor" })).toBeInTheDocument();
  });
});
