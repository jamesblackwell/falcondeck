import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { ComputerUseSetup } from "./ComputerUseSetup";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../api", () => ({
  isTauriDesktop: () => true,
}));

const mockedInvoke = vi.mocked(invoke);

describe("ComputerUseSetup", () => {
  beforeEach(() => {
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
});
