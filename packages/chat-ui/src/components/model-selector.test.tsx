import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSummary } from "@falcondeck/client-core";

import { STARRED_MODELS_STORAGE_KEY } from "../lib/starred-models";
import {
  ModelMenu,
  PermissionModeSelector,
  SandboxSelector,
} from "./model-selector";

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

function KeyboardModelMenu(props: Partial<ComponentProps<typeof ModelMenu>>) {
  const [effort, setEffort] = useState("medium");
  const [fast, setFast] = useState(false);
  return (
    <ModelMenu
      models={MODELS}
      selectedModel={MODELS[0]}
      onModelChange={vi.fn()}
      reasoningOptions={["low", "medium", "high"]}
      selectedEffort={effort}
      fastTier={{ id: "fast", name: "Fast", description: "2x speed" }}
      fastActive={fast}
      showFastRow
      {...props}
      onEffortChange={(next) => {
        setEffort(next);
        props.onEffortChange?.(next);
      }}
      onFastActiveChange={(next) => {
        setFast(next);
        props.onFastActiveChange?.(next);
      }}
    />
  );
}

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
    expect(keycapTexts()).toEqual(["⌃", "⇧", "M", "←", "→"]);
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

  it("does not repeat an effort already encoded in the model label", () => {
    const fixedEffortModel = model(
      "gemini-3.7-flash-medium",
      "Gemini 3.7 Flash (Medium)",
    );
    render(
      <ModelMenu
        models={[fixedEffortModel]}
        selectedModel={fixedEffortModel}
        onModelChange={() => {}}
        reasoningOptions={["medium"]}
        selectedEffort="medium"
        onEffortChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "gemini 3.7 flash (medium)",
    );
    expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent(
      "(medium)Medium",
    );
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

describe("ModelMenu keyboard shortcuts", () => {
  it("steps through effort from model and fast rows, clamping at the ends", () => {
    const onEffortChange = vi.fn();
    const onModelChange = vi.fn();
    render(
      <KeyboardModelMenu
        onEffortChange={onEffortChange}
        onModelChange={onModelChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const menu = screen.getByRole("menu");
    const initialHighlight = menu.getAttribute("aria-activedescendant");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "High" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onEffortChange).toHaveBeenCalledTimes(1);
    expect(menu).toHaveAttribute("aria-activedescendant", initialHighlight);

    fireEvent.mouseEnter(screen.getByRole("menuitemcheckbox", { name: "Fast mode" }));
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "Low" })).toHaveAttribute("aria-checked", "true");
    expect(onEffortChange.mock.calls.map(([effort]) => effort)).toEqual(["high", "medium", "low"]);
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("toggles fast mode with F without closing or changing the model highlight", () => {
    render(<KeyboardModelMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(keycapTexts()).toEqual(["←", "→", "F"]);
    const menu = screen.getByRole("menu");
    const initialHighlight = menu.getAttribute("aria-activedescendant");
    const fast = screen.getByRole("menuitemcheckbox", { name: "Fast mode" });

    fireEvent.keyDown(document, { key: "f" });
    expect(fast).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(document, { key: "f", repeat: true });
    expect(fast).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(document, { key: "F" });
    expect(fast).toHaveAttribute("aria-checked", "false");
    expect(menu).toHaveAttribute("aria-activedescendant", initialHighlight);
  });

  it("handles shortcuts while focus stays in the composer", () => {
    const onEffortChange = vi.fn();
    const onFastActiveChange = vi.fn();
    render(
      <>
        <textarea aria-label="Draft" />
        <KeyboardModelMenu
          open
          onEffortChange={onEffortChange}
          onFastActiveChange={onFastActiveChange}
        />
      </>,
    );
    const draft = screen.getByRole("textbox", { name: "Draft" });
    expect(fireEvent.keyDown(draft, { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(draft, { key: "f" })).toBe(false);
    expect(onEffortChange).toHaveBeenCalledWith("high");
    expect(onFastActiveChange).toHaveBeenCalledWith(true);
  });

  it("leaves modified keys, composition, and closed pickers alone", () => {
    const onEffortChange = vi.fn();
    const onFastActiveChange = vi.fn();
    render(
      <KeyboardModelMenu
        onEffortChange={onEffortChange}
        onFastActiveChange={onFastActiveChange}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "f" });
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey", "isComposing"]) {
      fireEvent.keyDown(document, { key: "ArrowRight", [modifier]: true });
      fireEvent.keyDown(document, { key: "f", [modifier]: true });
    }
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "f" });
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastActiveChange).not.toHaveBeenCalled();
  });

  it("preserves typing and caret movement in the model search field", () => {
    const onEffortChange = vi.fn();
    const onFastActiveChange = vi.fn();
    render(
      <KeyboardModelMenu
        models={Array.from({ length: 8 }, (_, i) =>
          model(`model-${i}`, `Model ${i}`),
        )}
        onEffortChange={onEffortChange}
        onFastActiveChange={onFastActiveChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const search = screen.getByRole("searchbox", { name: "Search models" });
    expect(fireEvent.keyDown(search, { key: "f" })).toBe(true);
    expect(fireEvent.keyDown(search, { key: "ArrowLeft" })).toBe(true);
    expect(fireEvent.keyDown(search, { key: "ArrowRight" })).toBe(true);
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastActiveChange).not.toHaveBeenCalled();
  });

  it("does not toggle unavailable fast mode or change effort in the handoff panel", () => {
    const onEffortChange = vi.fn();
    const onFastActiveChange = vi.fn();
    render(
      <KeyboardModelMenu
        fastTier={null}
        handoffProviders={[{ provider: "claude", label: "Claude" }]}
        onHandoffProviderSelect={vi.fn()}
        onEffortChange={onEffortChange}
        onFastActiveChange={onFastActiveChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Fast mode" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "f" });
    fireEvent.click(screen.getByRole("menuitem", { name: /Continue in another harness/ }));
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "f" });
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastActiveChange).not.toHaveBeenCalled();
  });
});

describe("ModelMenu loading", () => {
  it("opens an empty menu and reports that models are still loading", async () => {
    render(
      <ModelMenu
        models={[]}
        selectedModel={null}
        onModelChange={vi.fn()}
        reasoningOptions={[]}
        selectedEffort={null}
        onEffortChange={vi.fn()}
        modelsLoading
      />,
    );
    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger).not.toBeDisabled();
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Loading models…");
    });
    expect(screen.queryByText(/No models match/)).toBeNull();
  });

  it("keeps the trigger disabled when nothing is loading and no models exist", () => {
    render(
      <ModelMenu
        models={[]}
        selectedModel={null}
        onModelChange={vi.fn()}
        reasoningOptions={[]}
        selectedEffort={null}
        onEffortChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Model" })).toBeDisabled();
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

    const trigger = screen.getByRole("combobox", { name: "Permission mode" });
    expect(trigger).toHaveTextContent("Bypass");
    expect(trigger).not.toHaveTextContent("Bypass permissions");
    expect(trigger).toHaveClass("whitespace-nowrap");

    fireEvent.pointerDown(
      trigger,
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

describe("SandboxSelector", () => {
  it("uses a compact default label in the toolbar", () => {
    render(
      <SandboxSelector
        value={null}
        modes={["default", "sandbox"]}
        onValueChange={() => {}}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Sandbox mode" });
    expect(trigger).toHaveTextContent("Default");
    expect(trigger).not.toHaveTextContent("Default sandbox");
    expect(trigger).toHaveClass("whitespace-nowrap");
  });
});
