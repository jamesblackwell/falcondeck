import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionSidebarFilterDefinition } from "@falcondeck/client-core";

import { ExtensionSidebarFilters } from "./extension-sidebar-filters";

const definition: ExtensionSidebarFilterDefinition = {
  key: "example.colors:colors",
  extensionId: "example.colors",
  extensionName: "Colours",
  contributionId: "colors",
  title: "Colours",
  document: {
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
  },
  unsupportedReason: null,
};

describe("ExtensionSidebarFilters", () => {
  it("renders a keyboard-semantic filter menu and reports selected values", () => {
    const onChange = vi.fn();
    render(
      <ExtensionSidebarFilters
        definitions={[definition]}
        selections={new Map()}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter by colour" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Red" }));

    expect(onChange).toHaveBeenCalledWith(definition.key, new Set(["red"]));
  });

  it("moves between menu options with standard arrow keys", () => {
    render(
      <ExtensionSidebarFilters
        definitions={[
          {
            ...definition,
            document: {
              version: 1,
              root: {
                type: "select",
                id: "colors",
                label: "Filter by colour",
                multiple: true,
                options: [
                  { value: "red", label: "Red", tone: "red" },
                  { value: "blue", label: "Blue", tone: "blue" },
                ],
                binding: {
                  view: "thread-tags",
                  path: ["tagIds"],
                  operator: "includes_any",
                },
              },
            },
          },
        ]}
        selections={new Map()}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter by colour" }));
    const menu = screen.getByRole("menu");
    const red = screen.getByRole("menuitemcheckbox", { name: "Red" });
    const blue = screen.getByRole("menuitemcheckbox", { name: "Blue" });
    red.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });

    expect(document.activeElement).toBe(blue);
  });

  it("keeps malformed or newer filter documents inspectable", () => {
    render(
      <ExtensionSidebarFilters
        definitions={[
          {
            ...definition,
            document: null,
            unsupportedReason:
              "Declarative UI v2 is not supported by this client",
          },
        ]}
        selections={new Map()}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Colours: unsupported extension filter",
      }),
    );

    expect(screen.getByRole("status").textContent).toContain("v2");
  });
});
