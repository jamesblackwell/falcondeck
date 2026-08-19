import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSummary } from "@falcondeck/client-core";

import { STARRED_MODELS_STORAGE_KEY } from "../lib/starred-models";
import { ModelMenu, PermissionModeSelector } from "./model-selector";

function model(id: string, label: string): ModelSummary {
  return {
    id,
    label,
    is_default: false,
    default_reasoning_effort: null,
    supported_reasoning_efforts: [],
  };
}

const MODELS = [
  model("gpt-5.6-sol", "GPT-5.6-Sol"),
  model("gpt-5.6", "GPT-5.6"),
  model("gpt-5.5", "GPT-5.5"),
];

/** Keycap badges, read from document.body because portals escape the container. */
function keycapTexts() {
  return Array.from(document.body.querySelectorAll("kbd")).map(
    (node) => node.textContent,
  );
}

beforeAll(() => {
  // Radix opens and scrolls its select through APIs jsdom does not implement.
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("ModelMenu", () => {
  it("shows the opening shortcut as keycaps beside the Model title", async () => {
    render(
      <ModelMenu
        models={MODELS}
        selectedModel={MODELS[0]}
        onModelChange={() => {}}
        reasoningOptions={["low", "high"]}
        selectedEffort="high"
        onEffortChange={() => {}}
        shortcutHint={["⌃", "⇧", "M"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    await waitFor(() => {
      expect(screen.getByText("Reasoning effort")).toBeInTheDocument();
    });
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(keycapTexts()).toEqual(["⌃", "⇧", "M"]);
  });

  it("renders the title without keycaps when no shortcut is bound", async () => {
    render(
      <ModelMenu
        models={MODELS}
        selectedModel={MODELS[0]}
        onModelChange={() => {}}
        reasoningOptions={[]}
        selectedEffort={null}
        onEffortChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: "gpt-5.6-sol" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(keycapTexts()).toEqual([]);
  });

  it("pins a starred model to the top without changing the selection", async () => {
    const onModelChange = vi.fn();
    render(
      <ModelMenu
        models={MODELS}
        selectedModel={MODELS[0]}
        onModelChange={onModelChange}
        reasoningOptions={[]}
        selectedEffort={null}
        onEffortChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: "gpt-5.6-sol" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Star gpt-5.5" }));

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6",
    ]);
    expect(screen.getByRole("button", { name: "Unstar gpt-5.5" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(onModelChange).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(STARRED_MODELS_STORAGE_KEY) ?? "[]")).toEqual(
      ["gpt-5.5"],
    );
  });

  it("restores starred models at the top after remounting", async () => {
    window.localStorage.setItem(
      STARRED_MODELS_STORAGE_KEY,
      JSON.stringify(["gpt-5.6"]),
    );

    render(
      <ModelMenu
        models={MODELS}
        selectedModel={MODELS[0]}
        onModelChange={() => {}}
        reasoningOptions={[]}
        selectedEffort={null}
        onEffortChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));

    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: "gpt-5.6" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getAllByRole("menuitemradio").map((radio) => radio.textContent),
    ).toEqual(["gpt-5.6", "gpt-5.6-sol", "gpt-5.5"]);
  });
});

describe("PermissionModeSelector", () => {
  it("carries a Permissions title with its shortcut keycaps", async () => {
    render(
      <PermissionModeSelector
        value="bypassPermissions"
        modes={["default", "bypassPermissions"]}
        onValueChange={() => {}}
        shortcutHint={["⌃", "⇧", "P"]}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Permission mode" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );

    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "Bypass permissions" }),
      ).toBeInTheDocument();
    });
    // The header stays aria-hidden so the listbox semantics remain on options.
    expect(screen.getByText("Permissions")).toBeInTheDocument();
    expect(keycapTexts()).toEqual(["⌃", "⇧", "P"]);
  });
});
