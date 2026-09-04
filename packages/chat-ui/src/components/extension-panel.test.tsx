import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionPanelDefinition } from "@falcondeck/client-core";

import { ExtensionPanel, ExtensionPanelNavigation } from "./extension-panel";

const panel: ExtensionPanelDefinition = {
  key: "example.zen:attention",
  extensionId: "example.zen",
  extensionName: "Example Zen",
  contributionId: "attention",
  title: "Mini Zen",
  document: {
    version: 1,
    root: { type: "text", text: "One thing at a time" },
  },
  unsupportedReason: null,
};

describe("ExtensionPanel", () => {
  it("renders declarative content and a close affordance", () => {
    const onClose = vi.fn();
    render(<ExtensionPanel panel={panel} onClose={onClose} />);

    expect(screen.getByRole("heading", { name: "Mini Zen" })).toBeTruthy();
    expect(screen.getByText("Example Zen")).toBeTruthy();
    expect(screen.getByText("One thing at a time")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Mini Zen" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("hides the extension name when it matches the panel title", () => {
    render(
      <ExtensionPanel
        panel={{ ...panel, title: "Example Zen" }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Example Zen")).toHaveLength(1);
  });

  it("keeps unsupported panel content visible", () => {
    render(
      <ExtensionPanel
        panel={{
          ...panel,
          document: null,
          unsupportedReason: "Declarative UI v2 is not supported",
        }}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Declarative UI v2 is not supported",
    );
  });
});

describe("ExtensionPanelNavigation", () => {
  it("selects a registered panel by its stable key", () => {
    const onSelect = vi.fn();
    render(<ExtensionPanelNavigation panels={[panel]} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Mini Zen" }));
    expect(onSelect).toHaveBeenCalledWith("example.zen:attention");
  });

  it("renders a host-owned panel icon and falls back for unknown names", () => {
    const { rerender } = render(
      <ExtensionPanelNavigation
        panels={[{ ...panel, icon: "notebook-pen" }]}
        onSelect={vi.fn()}
      />,
    );

    expect(document.querySelector(".lucide-notebook-pen")).toBeTruthy();

    rerender(
      <ExtensionPanelNavigation
        panels={[{ ...panel, icon: "spaceship" }]}
        onSelect={vi.fn()}
      />,
    );
    expect(document.querySelector(".lucide-panels-top-left")).toBeTruthy();
  });
});
