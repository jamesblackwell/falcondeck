import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_REWRITE_PROMPT,
  readDictationSettings,
} from "../dictation";
import { DictationSetup } from "./DictationSetup";

describe("DictationSetup voice rewrite", () => {
  afterEach(() => window.localStorage.clear());

  it("opens the custom prompt pre-filled with the built-in prompt", () => {
    render(<DictationSetup baseUrl={null} onToast={() => {}} />);
    expect(screen.queryByLabelText("Rewrite prompt")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /custom prompt/i }));

    expect(screen.getByLabelText("Rewrite prompt")).toHaveValue(
      DEFAULT_REWRITE_PROMPT,
    );
    expect(
      screen.getByRole("button", { name: /reset to built-in/i }),
    ).toBeDisabled();
  });

  it("saves a custom prompt and can reset it", () => {
    render(<DictationSetup baseUrl={null} onToast={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /custom prompt/i }));

    const textarea = screen.getByLabelText("Rewrite prompt");
    fireEvent.change(textarea, {
      target: { value: "Return only the rewritten text." },
    });
    fireEvent.blur(textarea);

    expect(readDictationSettings().rewritePrompt).toBe(
      "Return only the rewritten text.",
    );
    expect(
      screen.getByRole("button", { name: /reset to built-in/i }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /reset to built-in/i }));

    expect(readDictationSettings().rewritePrompt).toBeNull();
    expect(textarea).toHaveValue(DEFAULT_REWRITE_PROMPT);
    expect(
      screen.getByRole("button", { name: /reset to built-in/i }),
    ).toBeDisabled();
  });

  it("onboarding compact keeps enable, shortcut, and rewrite without settings extras", () => {
    render(<DictationSetup baseUrl={null} onToast={() => {}} compact />)

    expect(screen.getByText("System-wide dictation")).toBeInTheDocument()
    expect(
      within(screen.getByRole("group", { name: "Dictation shortcut" })).getByRole(
        "button",
        { name: "Right Command" },
      ),
    ).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText("Rewrite selected text")).toBeInTheDocument()
    expect(
      within(screen.getByRole("group", { name: "Rewrite shortcut" })).getByRole(
        "button",
        { name: "Right Option" },
      ),
    ).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByText("Re-paste last transcript with ⌘⇧V")).toBeNull()
    expect(screen.queryByText("Transcription")).toBeNull()
    expect(screen.queryByText("Custom prompt")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Apple Speech" }),
    ).toBeNull()
  })

  it("lists gpt-oss-120b as a rewrite model", () => {
    render(<DictationSetup baseUrl={null} onToast={() => {}} />);
    expect(
      screen.getByRole("option", { name: "GPT-OSS 120B" }),
    ).toBeInTheDocument();
  });
});
