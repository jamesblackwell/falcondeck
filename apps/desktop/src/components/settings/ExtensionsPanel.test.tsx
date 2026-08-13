import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionSnapshot } from "@falcondeck/client-core";

import { ExtensionsPanel } from "./ExtensionsPanel";

describe("ExtensionsPanel compatibility fallback", () => {
  it("keeps newer contribution kinds visible to an older client", () => {
    const extensions: ExtensionSnapshot = {
      catalog: [
        {
          id: "example.future",
          name: "Future extension",
          version: "1.0.0",
          source: "local",
          bundled: false,
          enabled: true,
          status: "active",
          contributes: {
            threadMenuActions: [],
            threadDecorations: [],
            sidebarFilters: [],
            unsupported: [
              { kind: "statusBarItems", entries: [{ id: "future" }] },
            ],
          },
          permissions: [],
        },
      ],
      views: [],
    };

    render(
      <ExtensionsPanel
        extensions={extensions}
        onSetEnabled={vi.fn()}
        onSetPermission={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("statusBarItems");
  });

  it("shows denied-by-default grants and routes explicit approval", async () => {
    const onSetPermission = vi.fn().mockResolvedValue(undefined);
    const extensions: ExtensionSnapshot = {
      catalog: [
        {
          id: "example.reader",
          name: "Summary reader",
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
            unsupported: [],
          },
          permissions: ["threads:read"],
          granted_permissions: [],
        },
      ],
      views: [],
    };

    render(
      <ExtensionsPanel
        extensions={extensions}
        onSetEnabled={vi.fn()}
        onSetPermission={onSetPermission}
      />,
    );

    expect(screen.getByText("Read thread summaries")).toBeTruthy();
    expect(
      screen.getByText(/Messages and transcripts stay private/),
    ).toBeTruthy();
    expect(screen.getByText("Not granted")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Grant threads:read for Summary reader",
      }),
    );
    await waitFor(() => {
      expect(onSetPermission).toHaveBeenCalledWith(
        "example.reader",
        "threads:read",
        true,
      );
    });
  });
});
