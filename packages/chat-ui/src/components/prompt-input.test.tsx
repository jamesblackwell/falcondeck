import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SavedPrompt } from "@falcondeck/client-core";

import { PromptInput } from "./prompt-input";

const savePrompt: SavedPrompt = {
  id: "prompt:save-prompt",
  label: "Save Prompt",
  alias: "/save-prompt",
  description: "Review a diff",
  argument_hint: "[path]",
  body: "Review this diff.\n\n$ARGUMENTS",
  source_kind: "project_file",
};

const props = {
  onSubmit: vi.fn(),
  onPickImages: vi.fn(),
  onRemoveAttachment: vi.fn(),
  attachments: [],
  selectedProvider: "codex" as const,
  onProviderChange: vi.fn(),
  models: [],
  selectedModelId: null,
  onModelChange: vi.fn(),
  reasoningOptions: ["low", "medium", "high"],
  selectedEffort: "medium",
  onEffortChange: vi.fn(),
};

describe("PromptInput saved prompts", () => {
  it("replaces /name and its arguments when the row is chosen", () => {
    const onValueChange = vi.fn();
    const onSubmit = vi.fn();
    const typed = "/save-prompt the login";
    render(
      <PromptInput
        {...props}
        value={typed}
        onValueChange={onValueChange}
        onSubmit={onSubmit}
        prompts={[savePrompt]}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "Message composer" });
    textarea.setSelectionRange(typed.length, typed.length);
    fireEvent.click(textarea);

    const command = screen.getByRole("option", { name: /save-prompt/i });
    expect(command).toHaveTextContent("Prompt");
    fireEvent.mouseDown(command);

    expect(onValueChange).toHaveBeenCalledWith("Review this diff.\n\nthe login");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("expands a saved prompt on Enter instead of sending the slash text", () => {
    const onValueChange = vi.fn();
    const onSubmit = vi.fn();
    const typed = "/save-prompt the login";
    render(
      <PromptInput
        {...props}
        value={typed}
        onValueChange={onValueChange}
        onSubmit={onSubmit}
        prompts={[savePrompt]}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "Message composer" });
    textarea.setSelectionRange(typed.length, typed.length);
    fireEvent.click(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onValueChange).toHaveBeenCalledWith("Review this diff.\n\nthe login");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
