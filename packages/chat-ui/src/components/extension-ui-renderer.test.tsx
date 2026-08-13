import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionUiDocument } from "@falcondeck/client-core";

import {
  ExtensionUiFallback,
  ExtensionUiRenderer,
} from "./extension-ui-renderer";

const document: ExtensionUiDocument = {
  version: 1,
  root: {
    type: "stack",
    gap: "small",
    children: [
      { type: "text", text: "Needs attention", style: "heading" },
      { type: "badge", text: "Blocked", tone: "warning" },
      {
        type: "button",
        label: "Refresh",
        action: { actionId: "refresh", input: { source: "panel" } },
      },
    ],
  },
};

describe("ExtensionUiRenderer", () => {
  it("renders semantic primitives and routes action bindings with extension identity", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <ExtensionUiRenderer
        extensionId="example.attention"
        document={document}
        onAction={onAction}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Needs attention" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith("example.attention", {
        actionId: "refresh",
        input: { source: "panel" },
      }),
    );
  });

  it("keeps action failures attributed beside the control that failed", async () => {
    render(
      <ExtensionUiRenderer
        extensionId="example.attention"
        document={document}
        onAction={() => Promise.reject(new Error("Host unavailable"))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Host unavailable",
    );
  });

  it("exposes select state through keyboard-accessible host controls", () => {
    const onSelectionChange = vi.fn();
    const filter: ExtensionUiDocument = {
      version: 1,
      root: {
        type: "select",
        id: "colors",
        label: "Filter by colour",
        multiple: true,
        options: [{ value: "red", label: "Red", tone: "red" }],
        binding: {
          view: "thread-tags",
          path: ["tagIds"],
          operator: "includes_any",
        },
      },
    };
    render(
      <ExtensionUiRenderer
        extensionId="example.colors"
        document={filter}
        selections={new Map([["colors", new Set<string>()]])}
        onSelectionChange={onSelectionChange}
      />,
    );

    const choice = screen.getByRole("checkbox", { name: "Red" });
    expect(choice.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(choice);
    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "colors" }),
      new Set(["red"]),
    );
  });

  it("renders the complete scoped v1 presentation vocabulary semantically", () => {
    const fixture: ExtensionUiDocument = {
      version: 1,
      root: {
        type: "stack",
        children: [
          {
            type: "row",
            wrap: true,
            children: [
              { type: "text", text: "Summary" },
              { type: "badge", text: "Ready", tone: "success" },
            ],
          },
          { type: "divider" },
          {
            type: "list",
            items: [
              { type: "text", text: "First item" },
              { type: "text", text: "Second item", style: "mono" },
            ],
          },
          {
            type: "state",
            state: "empty",
            title: "Nothing queued",
            description: "New attention items will appear here.",
          },
        ],
      },
    };

    render(
      <ExtensionUiRenderer
        extensionId="example.fixture"
        document={fixture}
      />,
    );

    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getByText("Second item").tagName).toBe("P");
    expect(screen.getByText("Nothing queued")).toBeTruthy();
    expect(screen.getByText("New attention items will appear here.")).toBeTruthy();
  });
});

describe("ExtensionUiFallback", () => {
  it("makes an unsupported contribution inspectable instead of dropping it", () => {
    render(
      <ExtensionUiFallback
        extensionName="Future extension"
        contributionKind="panel"
        reason="Declarative UI v2 is not supported by this client"
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "unsupported panel",
    );
    expect(screen.getByRole("status").textContent).toContain("v2");
  });
});
