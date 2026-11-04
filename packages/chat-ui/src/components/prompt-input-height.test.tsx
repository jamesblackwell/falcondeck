// Kept apart from prompt-input.test.tsx so the composer height rules can run
// on their own; apps/desktop/src/components/PromptInput.test.tsx hangs on main.
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@falcondeck/ui";

import {
  COMPOSER_EDITOR_MAX_HEIGHT,
  COMPOSER_EDITOR_MIN_HEIGHT,
  composerHeightLimits,
  UNMEASURED_COMPOSER,
} from "../lib/composer-height";
import { PromptInput } from "./prompt-input";

const metrics = (
  paneHeight: number,
  chromeHeight: number,
  rest: Partial<typeof UNMEASURED_COMPOSER> = {},
) => ({ ...UNMEASURED_COMPOSER, paneHeight, chromeHeight, ...rest });

describe("composerHeightLimits", () => {
  it("auto-grows to about three times the old cap and keeps one line", () => {
    const limits = composerHeightLimits(false, metrics(2000, 120));
    expect(limits.editorMin).toBe(COMPOSER_EDITOR_MIN_HEIGHT);
    expect(limits.editorMax).toBe(COMPOSER_EDITOR_MAX_HEIGHT);
    expect(limits.editorMax).toBeGreaterThanOrEqual(200 * 3);
  });

  it("keeps the whole composer within 60% of the pane", () => {
    for (const expanded of [false, true]) {
      const limits = composerHeightLimits(expanded, metrics(700, 120));
      expect(limits.editorMax + 120).toBeLessThanOrEqual(700 * 0.6);
      expect(limits.editorMin).toBeLessThanOrEqual(limits.editorMax);
    }
  });

  it("counts attachments against the budget and scrolls past half of it", () => {
    const small = composerHeightLimits(
      false,
      metrics(1000, 100, { extrasHeight: 90 }),
    );
    expect(small.editorMax + 90 + 100).toBeLessThanOrEqual(600);

    const huge = composerHeightLimits(
      true,
      metrics(1000, 100, { extrasHeight: 900 }),
    );
    expect(huge.extrasMax).toBe(250);
    expect(huge.editorMax + huge.extrasMax! + 100).toBeLessThanOrEqual(600);
    expect(huge.editorMax).toBe(250);
  });

  it("gives way to docked bars so the transcript and footer stay on screen", () => {
    // A 400px request card: transcript + composer share only 600 of 1000.
    const limits = composerHeightLimits(
      true,
      metrics(1000, 100, { roomHeight: 600 }),
    );
    expect(limits.editorMax + 100).toBeLessThanOrEqual(600 - 120);
    expect(limits.editorMin).toBeLessThanOrEqual(limits.editorMax);
  });

  it("keeps a one-line editor in a tiny window", () => {
    for (const expanded of [false, true]) {
      const limits = composerHeightLimits(expanded, metrics(200, 150));
      expect(limits.editorMin).toBe(COMPOSER_EDITOR_MIN_HEIGHT);
      expect(limits.editorMax).toBe(COMPOSER_EDITOR_MIN_HEIGHT);
    }
  });

  it("rests at half the pane when expanded", () => {
    const limits = composerHeightLimits(true, metrics(1000, 80));
    expect(limits.editorMin).toBe(500);
    expect(limits.editorMax).toBe(520);
  });

  it("is not capped at the auto-grow ceiling when expanded on a tall pane", () => {
    const limits = composerHeightLimits(true, metrics(2000, 120));
    expect(limits.editorMin).toBe(1000);
    expect(limits.editorMax).toBe(1080);
  });

  it("falls back to the fixed caps when the host marks no pane", () => {
    expect(composerHeightLimits(false, UNMEASURED_COMPOSER)).toEqual({
      editorMin: COMPOSER_EDITOR_MIN_HEIGHT,
      editorMax: COMPOSER_EDITOR_MAX_HEIGHT,
      extrasMax: undefined,
    });
    expect(composerHeightLimits(true, UNMEASURED_COMPOSER).editorMin).toBe(
      COMPOSER_EDITOR_MAX_HEIGHT,
    );
  });
});

const baseProps: ComponentProps<typeof PromptInput> = {
  value: "",
  onValueChange: vi.fn(),
  onSubmit: vi.fn(),
  attachments: [],
  selectedProvider: "codex",
  onProviderChange: vi.fn(),
  models: [],
  selectedModelId: null,
  onModelChange: vi.fn(),
  reasoningOptions: [],
  selectedEffort: null,
  onEffortChange: vi.fn(),
};

function setup(props: Partial<ComponentProps<typeof PromptInput>> = {}) {
  const tree = (next: Partial<ComponentProps<typeof PromptInput>>) => (
    <TooltipProvider>
      <PromptInput {...baseProps} {...props} {...next} />
    </TooltipProvider>
  );
  const view = render(tree({}));
  return {
    ...view,
    update: (next: Partial<ComponentProps<typeof PromptInput>>) =>
      view.rerender(tree(next)),
    textarea: screen.getByRole("textbox", {
      name: "Message composer",
    }) as HTMLTextAreaElement,
  };
}

const heightOf = (element: HTMLElement, height: number) =>
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    height,
    top: 0,
  } as DOMRect);

/** Renders inside a marked pane with a fixed height and transcript. */
function setupInPane(
  paneHeight: number,
  props: Partial<ComponentProps<typeof PromptInput>> = {},
) {
  const observers: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const pane = document.createElement("section");
  pane.dataset.conversationPane = "";
  const transcript = document.createElement("div");
  transcript.dataset.conversationViewport = "";
  pane.append(transcript);
  document.body.append(pane);
  heightOf(pane, paneHeight);
  heightOf(transcript, paneHeight - 160);

  const prototype = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "TEXTAREA") {
        return { height: parseFloat(this.style.height) || 52, top: 0 } as DOMRect;
      }
      // The root div: 100px of chrome plus the editor.
      const editor = this.querySelector("textarea");
      return {
        height: editor ? 100 + (parseFloat(editor.style.height) || 52) : 0,
        top: 0,
      } as DOMRect;
    });

  const view = render(
    <TooltipProvider>
      <PromptInput {...baseProps} {...props} />
    </TooltipProvider>,
    { container: pane.appendChild(document.createElement("div")) },
  );
  return {
    ...view,
    prototype,
    remeasure: () => act(() => observers.forEach((callback) => callback())),
    textarea: screen.getByRole("textbox", {
      name: "Message composer",
    }) as HTMLTextAreaElement,
  };
}

const scrollHeightOf = (element: HTMLElement, height: number) =>
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: height,
  });

describe("PromptInput height", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("grows with the draft to 600px, scrolls past it, and shrinks back", () => {
    const { textarea, update } = setup({ value: "one" });
    expect(textarea.style.minHeight).toBe("52px");
    expect(textarea.style.maxHeight).toBe("600px");

    scrollHeightOf(textarea, 340);
    update({ value: "several\nlines" });
    expect(textarea.style.height).toBe("340px");

    scrollHeightOf(textarea, 2000);
    update({ value: "a very long draft" });
    expect(textarea.style.height).toBe("600px");

    scrollHeightOf(textarea, 52);
    update({ value: "" });
    expect(textarea.style.height).toBe("52px");
  });

  it("toggles the tall mode from the button and refocuses the editor", () => {
    const { textarea } = setup({ value: "draft" });
    fireEvent.click(screen.getByRole("button", { name: "Expand prompt" }));
    expect(textarea.style.minHeight).toBe("600px");
    expect(textarea).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Collapse prompt" }));
    expect(textarea.style.minHeight).toBe("52px");
  });

  it("keeps sending on Enter and newlines on Shift-Enter while expanded", () => {
    const onSubmit = vi.fn();
    const { textarea } = setup({ value: "draft", onSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Expand prompt" }));

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.style.minHeight).toBe("600px");

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(textarea.style.minHeight).toBe("52px");
  });

  it("collapses on the send button and on voice send", () => {
    const { textarea, update } = setup({ value: "draft" });
    fireEvent.click(screen.getByRole("button", { name: "Expand prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(textarea.style.minHeight).toBe("52px");

    fireEvent.click(screen.getByRole("button", { name: "Expand prompt" }));
    const onStopAndSend = vi.fn();
    update({
      voice: {
        state: "recording",
        seconds: 1,
        configured: true,
        hasPending: false,
        onStop: vi.fn(),
        onStopAndSend,
        onCancel: vi.fn(),
        onRetry: vi.fn(),
        onDiscard: vi.fn(),
        onDismiss: vi.fn(),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Transcribe and send" }));
    expect(onStopAndSend).toHaveBeenCalledTimes(1);
    expect(textarea.style.minHeight).toBe("52px");
  });

  it("does not collapse when the draft cannot be sent", () => {
    const { textarea } = setup({ value: "draft", sendDisabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Expand prompt" }));
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.style.minHeight).toBe("600px");
  });

  it("follows the host's shortcut without replaying it on remount", () => {
    const { textarea, update, unmount } = setup({ expandRequestKey: 3 });
    expect(textarea.style.minHeight).toBe("52px");

    update({ expandRequestKey: 4 });
    expect(textarea.style.minHeight).toBe("600px");
    expect(textarea).toHaveFocus();
    unmount();

    // A thread switch remounts the composer, which leaves the tall mode.
    const remounted = setup({ expandRequestKey: 4 });
    expect(remounted.textarea.style.minHeight).toBe("52px");
  });

  it("ignores the shortcut while the composer is disabled", () => {
    const { textarea, update } = setup({ disabled: true });
    update({ disabled: true, expandRequestKey: 1 });
    expect(textarea.style.minHeight).toBe("52px");
  });

  it("applies the pane budget and tracks pane resizes", () => {
    const { textarea, prototype, remeasure } = setupInPane(1000);
    expect(textarea.style.maxHeight).toBe("500px");

    fireEvent.click(screen.getByRole("button", { name: "Expand prompt" }));
    expect(textarea.style.height).toBe("500px");

    // A shorter window lowers the cap with no typing involved.
    prototype.mockClear();
    const pane = textarea.closest<HTMLElement>("[data-conversation-pane]")!;
    heightOf(pane, 500);
    remeasure();
    expect(textarea.style.maxHeight).toBe("200px");
    expect(textarea.style.height).toBe("200px");
  });

  it("stays on the fixed caps when mounted outside a marked pane", () => {
    const { textarea } = setup();
    expect(textarea.style.maxHeight).toBe("600px");
  });

  it("scrolls attachments in the strip once they outgrow their share", () => {
    const attachment = {
      type: "image" as const,
      id: "a",
      name: "a.png",
      mime_type: "image/png",
      url: "data:image/png;base64,AA==",
    };
    const { container } = setupInPane(1000, { attachments: [attachment] });
    const strip = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    expect(strip.style.maxHeight).toBe("250px");
  });
});
