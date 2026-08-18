import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  ExtensionPanelDefinition,
  ExtensionSummary,
} from "@falcondeck/client-core";
import type { ExtensionAppPanelRegistration } from "@falcondeck/extension-sdk/app";

import { ExtensionAppPanel } from "./extension-app-panel";

const panel: ExtensionPanelDefinition = {
  key: "example.kanban:board",
  extensionId: "example.kanban",
  extensionName: "Example Kanban",
  contributionId: "board",
  title: "Kanban",
  document: null,
  unsupportedReason: null,
};

const extension: ExtensionSummary = {
  id: "example.kanban",
  name: "Example Kanban",
  version: "1.0.0",
  source: "bundled",
  bundled: true,
  enabled: true,
  status: "active",
  contributes: {
    threadMenuActions: [],
    threadDecorations: [],
    sidebarFilters: [],
    panels: [],
  },
  permissions: [],
  granted_permissions: [],
};

describe("ExtensionAppPanel", () => {
  it("contains a trusted frontend render failure to its panel", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const registration: ExtensionAppPanelRegistration = {
      id: "board",
      title: "Kanban",
      component() {
        throw new Error("broken frontend");
      },
    };

    render(
      <ExtensionAppPanel
        panel={panel}
        registration={registration}
        extension={extension}
        threads={[]}
        views={[]}
        onInvokeAction={vi.fn()}
        onOpenThread={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Example Kanban could not render this panel."),
    ).toBeVisible();
    consoleError.mockRestore();
  });
});
