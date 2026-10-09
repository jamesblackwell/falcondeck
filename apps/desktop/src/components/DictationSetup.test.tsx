import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REWRITE_PROMPT,
  readDictationSettings,
} from "../dictation";
import { DictationSetup } from "./DictationSetup";

const prepareParakeet = vi.hoisted(() => vi.fn());
vi.mock("../parakeet", () => ({ useParakeetStatus: () => ({
  status: { supported: true, installed: true, loaded: false, busy: false },
  preparing: false, error: null, prepare: prepareParakeet,
}) }));

describe("DictationSetup voice rewrite", () => {
  it("prepares Parakeet on selection and saves its advanced idle setting", () => {
    prepareParakeet.mockClear();
    render(<DictationSetup baseUrl={null} onToast={() => {}} />);
    expect(prepareParakeet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Parakeet" }));
    expect(prepareParakeet).toHaveBeenCalledTimes(1);
    expect(readDictationSettings().provider).toBe("parakeet");
    fireEvent.change(screen.getByLabelText("Keep model loaded"), { target: { value: "0" } });
    expect(readDictationSettings().parakeetIdleMinutes).toBe(0);
  });
  afterEach(() => window.localStorage.clear());

  it("keeps the OpenRouter online model and fallback controls", () => {
    render(<DictationSetup baseUrl={null} onToast={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "OpenRouter" }));
    expect(readDictationSettings().provider).toBe("open_router");
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Fallback model")).toBeInTheDocument();
  });

  it("shows the OpenRouter key for title suggestions with Apple Speech selected", () => {
    render(<DictationSetup baseUrl={null} onToast={() => {}} />);
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    expect(screen.getByText(/Used for title suggestions/)).toBeInTheDocument();
  });

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

  it("enables automatic cleanup independently of the rewrite shortcut", () => {
    render(<DictationSetup baseUrl={null} onToast={() => {}} />);
    const cleanup = screen.getByRole("switch", { name: "Automatically clean up transcriptions" });
    expect(cleanup).toHaveAttribute("aria-checked", "false");
    fireEvent.click(cleanup);
    expect(readDictationSettings().autoCleanupEnabled).toBe(true);
    expect(readDictationSettings().rewriteEnabled).toBe(false);
  });

  it("lists gpt-oss-120b as a rewrite model", () => {
    render(<DictationSetup baseUrl={null} onToast={() => {}} />);
    expect(
      screen.getByRole("option", { name: "GPT-OSS 120B" }),
    ).toBeInTheDocument();
  });
});
