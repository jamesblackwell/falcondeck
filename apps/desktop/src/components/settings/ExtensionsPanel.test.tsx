import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionSnapshot } from "@falcondeck/client-core";

import { ExtensionsPanel } from "./ExtensionsPanel";

describe("ExtensionsPanel compatibility fallback", () => {
  it("filters installed extensions and keeps enabled entries first", () => {
    const extension = (id: string, name: string, enabled: boolean) => ({
      id,
      name,
      version: "1.0.0",
      source: "bundled",
      bundled: true,
      enabled,
      status: enabled ? ("active" as const) : ("disabled" as const),
      contributes: {
        threadMenuActions: [],
        threadDecorations: [],
        sidebarFilters: [],
      },
      permissions: [],
    });
    const extensions: ExtensionSnapshot = {
      catalog: [
        extension("example.disabled", "Disabled helper", false),
        extension("example.enabled", "Enabled helper", true),
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

    const enabled = screen.getByText("Enabled helper");
    const disabled = screen.getByText("Disabled helper");
    expect(enabled.compareDocumentPosition(disabled)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      screen.getAllByTitle("Built and maintained by FalconDeck"),
    ).toHaveLength(2);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "disabled" },
    });
    expect(screen.queryByText("Enabled helper")).not.toBeInTheDocument();
    expect(screen.getByText("Disabled helper")).toBeInTheDocument();
  });

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
    expect(screen.queryByText("Official")).not.toBeInTheDocument();
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
