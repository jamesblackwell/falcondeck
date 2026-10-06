import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionSnapshot } from "@falcondeck/client-core";

import { ExtensionsPanel } from "./ExtensionsPanel";

function setupEnablement(permissions = ["threads:read"], granted: string[] = []) {
  const onSetEnabled = vi.fn().mockResolvedValue(undefined);
  const onSetPermission = vi.fn().mockResolvedValue(undefined);
  render(
    <ExtensionsPanel
      extensions={{
        catalog: [{
          id: "example.reader", name: "Summary reader", version: "1.0.0",
          source: "bundled", bundled: true, enabled: false, status: "disabled",
          contributes: { threadMenuActions: [], threadDecorations: [], sidebarFilters: [] },
          permissions, granted_permissions: granted,
        }],
        views: [],
      }}
      onSetEnabled={onSetEnabled}
      onSetPermission={onSetPermission}
    />,
  );
  const enable = screen.getByRole("button", { name: "Enable" });
  enable.focus();
  fireEvent.click(enable);
  return { onSetEnabled, onSetPermission };
}

describe("extension enablement", () => {
  it("requests consent and grants missing permissions before enabling", async () => {
    const { onSetEnabled, onSetPermission } = setupEnablement(
      ["threads:read", "agent-tools:register"], ["agent-tools:register"],
    );
    const dialog = screen.getByRole("dialog", { name: "Enable Summary reader?" });
    expect(within(dialog).getByText("Read thread summaries")).toBeVisible();
    expect(within(dialog).queryByText("Offer tools to agents")).not.toBeInTheDocument();
    expect(onSetPermission).not.toHaveBeenCalled();
    expect(onSetEnabled).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Allow and enable" }));
    await waitFor(() => expect(onSetEnabled).toHaveBeenCalledWith("example.reader", true));
    expect(onSetPermission).toHaveBeenCalledExactlyOnceWith("example.reader", "threads:read", true);
    expect(onSetPermission.mock.invocationCallOrder[0]).toBeLessThan(onSetEnabled.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("leaves enablement and grants unchanged when cancelled", () => {
    const { onSetEnabled, onSetPermission } = setupEnablement();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onSetPermission).not.toHaveBeenCalled();
    expect(onSetEnabled).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enable" })).toHaveFocus();
  });

  it("keeps keyboard focus in the prompt and dismisses with Escape", () => {
    const { onSetEnabled, onSetPermission } = setupEnablement();
    const dialog = screen.getByRole("dialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const allow = within(dialog).getByRole("button", { name: "Allow and enable" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(allow).toHaveFocus();
    fireEvent.keyDown(allow, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onSetEnabled).not.toHaveBeenCalled();
    expect(onSetPermission).not.toHaveBeenCalled();
  });

  it("waits for all approved grants before activation and keeps the busy prompt open", async () => {
    const { onSetEnabled, onSetPermission } = setupEnablement(["threads:read", "agent-tools:register"]);
    let finishGrant!: () => void;
    onSetPermission.mockImplementationOnce(() => new Promise<void>((resolve) => { finishGrant = resolve; }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow and enable" }));
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
    expect(onSetEnabled).not.toHaveBeenCalled();
    expect(onSetPermission).toHaveBeenCalledTimes(1);

    await act(async () => finishGrant());
    await waitFor(() => expect(onSetEnabled).toHaveBeenCalledWith("example.reader", true));
    expect(onSetPermission).toHaveBeenNthCalledWith(2, "example.reader", "agent-tools:register", true);
    expect(onSetPermission.mock.invocationCallOrder[1]).toBeLessThan(onSetEnabled.mock.invocationCallOrder[0]!);
  });

  it("does not enable an extension when a permission grant fails", async () => {
    const { onSetEnabled, onSetPermission } = setupEnablement(["threads:read", "agent-tools:register"]);
    onSetPermission.mockRejectedValueOnce(new Error("Could not save permission"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Allow and enable" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Could not save permission");
    expect(onSetEnabled).not.toHaveBeenCalled();
    expect(onSetPermission).toHaveBeenCalledTimes(1);
  });

  it.each([
    { permissions: [] as string[], granted: [] },
    { permissions: ["threads:read"], granted: ["threads:read"] },
  ])("enables directly when no permission approval is needed: $permissions/$granted", async ({ permissions, granted }) => {
    const { onSetEnabled, onSetPermission } = setupEnablement(permissions, granted);
    await waitFor(() => expect(onSetEnabled).toHaveBeenCalledWith("example.reader", true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onSetPermission).not.toHaveBeenCalled();
  });
});

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
