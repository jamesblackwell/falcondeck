import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ComputerUseStatus } from "@falcondeck/client-core";

import { ComputerUseSetup } from "./ComputerUseSetup";

const api = vi.hoisted(() => ({
  computerUse: vi.fn(),
  restartComputerUse: vi.fn(),
  testComputerUse: vi.fn(),
}));

vi.mock("@falcondeck/client-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@falcondeck/client-core")>(),
  createDaemonApiClient: () => api,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../api", () => ({
  isTauriDesktop: () => true,
}));

const mockedInvoke = vi.mocked(invoke);
const agentDesktopStatus: ComputerUseStatus = {
  backend: "agent_desktop",
  agent_desktop_binary_present: true,
  available: true,
  enabled: true,
  macos_ok: true,
  binary_present: true,
  permissions: { accessibility: true, screen_recording: true },
  driver_version: "1.0.2",
  telemetry: false,
  overlay: true,
  running: false,
};

describe("ComputerUseSetup", () => {
  beforeEach(() => {
    api.computerUse.mockReset();
    api.restartComputerUse.mockReset();
    api.testComputerUse.mockReset();
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue({
      accessibility: false,
      screenRecording: true,
      macosOk: true,
      macosMajor: 15,
      supported: true,
    });
  });

  it("shows both permission rows and grant buttons", async () => {
    render(<ComputerUseSetup baseUrl={null} onToast={() => {}} />);
    expect(await screen.findByText("Accessibility")).toBeInTheDocument();
    expect(screen.getByText("Screen Recording")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grant" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restart FalconDeck" }),
    ).toBeNull();
  });

  it("offers an app restart in the compact onboarding layout", async () => {
    render(<ComputerUseSetup baseUrl={null} onToast={() => {}} compact />);
    expect(
      await screen.findByRole("button", { name: "Restart FalconDeck" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Setup continues on this step/)).toBeInTheDocument();
  });

  it("flushes onBeforeAppRestart before invoking restart_app", async () => {
    const onBeforeAppRestart = vi.fn();
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "restart_app") {
        expect(onBeforeAppRestart).toHaveBeenCalledTimes(1);
        return;
      }
      return {
        accessibility: false,
        screenRecording: false,
        macosOk: true,
        macosMajor: 15,
        supported: true,
      };
    });
    render(
      <ComputerUseSetup
        baseUrl={null}
        onToast={() => {}}
        compact
        onBeforeAppRestart={onBeforeAppRestart}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart FalconDeck" }),
    );
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("restart_app");
    });
  });

  it("explains when macOS is too old", async () => {
    mockedInvoke.mockResolvedValue({
      accessibility: false,
      screenRecording: false,
      macosOk: false,
      macosMajor: 13,
      supported: true,
    });
    render(<ComputerUseSetup baseUrl={null} onToast={() => {}} />);
    expect(
      await screen.findByText(/Computer use needs macOS 14 or later/),
    ).toBeInTheDocument();
  });

  it("tests and refreshes agent-desktop without requiring a running driver", async () => {
    mockedInvoke.mockResolvedValue({
      accessibility: true,
      screenRecording: true,
      macosOk: true,
      macosMajor: 15,
      supported: true,
    });
    api.computerUse.mockResolvedValue(agentDesktopStatus);
    api.restartComputerUse.mockResolvedValue(agentDesktopStatus);
    api.testComputerUse.mockResolvedValue({ ok: true });
    const onToast = vi.fn();
    render(<ComputerUseSetup baseUrl="http://localhost:1" onToast={onToast} />);

    expect(await screen.findByText("agent-desktop 1.0.2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart driver" })).not.toBeInTheDocument();
    const testButton = screen.getByRole("button", { name: "Test it" });
    await waitFor(() => expect(testButton).toBeEnabled());
    fireEvent.click(testButton);
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Computer use is working",
    })));

    fireEvent.click(screen.getByRole("button", { name: "Refresh agent-desktop" }));
    await waitFor(() => expect(api.restartComputerUse).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({
      variant: "success",
      title: "agent-desktop refreshed",
    }));
  });

  it("keeps testing disabled while the selected backend is missing", async () => {
    const missing = { ...agentDesktopStatus, binary_present: false, agent_desktop_binary_present: false };
    api.computerUse.mockResolvedValue(missing);
    render(<ComputerUseSetup baseUrl="http://localhost:1" status={missing} onToast={() => {}} />);

    const button = await screen.findByRole("button", { name: "Test it" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Install agent-desktop before testing it.");
    expect(api.testComputerUse).not.toHaveBeenCalled();
  });

  it("does not publish an old status after switching to a new setup instance", async () => {
    let finish!: (status: ComputerUseStatus) => void;
    api.computerUse.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onStatusChange = vi.fn();
    const { unmount } = render(
      <ComputerUseSetup baseUrl="http://localhost:1" onStatusChange={onStatusChange} onToast={() => {}} />,
    );
    await waitFor(() => expect(api.computerUse).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => { finish(agentDesktopStatus); });

    expect(onStatusChange).not.toHaveBeenCalled();
  });
});
