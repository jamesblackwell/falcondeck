import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { ComputerUsePanel } from "./ComputerUsePanel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../../api", () => ({
  isTauriDesktop: () => true,
}));

const mockedInvoke = vi.mocked(invoke);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ComputerUsePanel", () => {
  beforeEach(() => {
    mockedInvoke.mockResolvedValue({
      accessibility: true,
      screenRecording: true,
      macosOk: true,
      macosMajor: 15,
      supported: true,
    });
  });

  it("renders the opt-in switch and permission rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          available: true,
          enabled: false,
          macos_ok: true,
          binary_present: true,
          permissions: { accessibility: true, screen_recording: true },
          telemetry: false,
          overlay: true,
          running: false,
        }),
      ),
    );
    render(
      <ComputerUsePanel baseUrl="http://127.0.0.1:4123" onToast={() => {}} />,
    );
    expect(
      await screen.findByText("Allow agents to use this Mac"),
    ).toBeInTheDocument();
    expect(screen.getByText("Share anonymous driver telemetry with Cua")).toBeInTheDocument();
    expect(screen.getByText("Accessibility")).toBeInTheDocument();
  });
});
