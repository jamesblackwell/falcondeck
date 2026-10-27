import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUsePanel } from "./ComputerUsePanel";

const api = vi.hoisted(() => ({ computerUse: vi.fn(), updateComputerUse: vi.fn(), openAgentBrowser: vi.fn() }));
vi.mock("@falcondeck/client-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@falcondeck/client-core")>(),
  createDaemonApiClient: () => api,
}));
vi.mock("../ComputerUseSetup", () => ({ ComputerUseSetup: () => null }));

const status = { available: true, enabled: true, overlay: true, telemetry: false, existing_profile: false };
const label = "Allow agents to use my personal Chrome profile";

describe("signed-in browser consent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.computerUse.mockResolvedValue(status);
  });

  it("keeps consent separate from computer use and sends explicit opt-in and revocation", async () => {
    api.updateComputerUse.mockImplementation(async (update) => ({ ...status, ...update }));
    render(<ComputerUsePanel baseUrl="http://localhost:1" onToast={() => {}} />);
    const toggle = screen.getByRole("switch", { name: label });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(api.updateComputerUse).toHaveBeenLastCalledWith({ existing_profile: true });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(api.updateComputerUse).toHaveBeenLastCalledWith({ existing_profile: false });
  });

  it("disables consent for an older daemon", async () => {
    api.computerUse.mockResolvedValue({ ...status, existing_profile: undefined });
    render(<ComputerUsePanel baseUrl="http://localhost:1" onToast={() => {}} />);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Allow agents to use this Mac" })).toBeChecked());
    expect(screen.getByRole("switch", { name: label })).toBeDisabled();
  });

  it("does not display consent as granted after a failed save", async () => {
    const onToast = vi.fn();
    api.updateComputerUse.mockRejectedValue(new Error("Save failed"));
    render(<ComputerUsePanel baseUrl="http://localhost:1" onToast={onToast} />);
    const toggle = screen.getByRole("switch", { name: label });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(onToast).toHaveBeenCalled());
    expect(toggle).not.toBeChecked();
  });

  it("opens the agent browser and reports a failed launch", async () => {
    const onToast = vi.fn();
    api.openAgentBrowser.mockRejectedValueOnce(new Error("Could not open Google Chrome"));
    render(<ComputerUsePanel baseUrl="http://localhost:1" onToast={onToast} />);
    const button = screen.getByRole("button", { name: "Open agent browser" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.objectContaining({
      description: "Could not open Google Chrome",
    })));
    fireEvent.click(button);
    await waitFor(() => expect(api.openAgentBrowser).toHaveBeenCalledTimes(2));
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  it("keeps the agent browser closed while computer use is off", async () => {
    api.computerUse.mockResolvedValue({ ...status, enabled: false });
    render(<ComputerUsePanel baseUrl="http://localhost:1" onToast={() => {}} />);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Allow agents to use this Mac" })).not.toBeChecked());
    expect(screen.getByRole("button", { name: "Open agent browser" })).toBeDisabled();
  });
});
