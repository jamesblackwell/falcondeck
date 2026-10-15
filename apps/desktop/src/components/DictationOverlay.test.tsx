import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DictationOverlay } from "./DictationOverlay";

type Handler = (message: { payload: unknown }) => void;

const listeners = new Map<string, Set<Handler>>();
const invoked: string[] = [];
const invocationArgs: Array<unknown> = [];
let rejectedCommand: string | null = null;
let deferCopy = false;
let rejectCopy: ((reason: string) => void) | undefined;
let deferFix = false;
let rejectFix: ((reason: string) => void) | undefined;

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Handler) => {
    const handlers = listeners.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    listeners.set(event, handlers);
    return Promise.resolve(() => handlers.delete(handler));
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    if (command === "copy_dictation_transcript" && deferCopy) {
      return new Promise<void>((_resolve, reject) => { rejectCopy = reject; });
    }
    if (command === "fix_dictation_transcript" && deferFix) {
      return new Promise<void>((_resolve, reject) => { rejectFix = reject; });
    }
    invoked.push(command);
    invocationArgs.push(args);
    if (command === rejectedCommand) return Promise.reject("Clipboard unavailable");
    return Promise.resolve();
  },
}));

async function emit(event: string, payload: unknown) {
  await act(async () => {
    for (const handler of listeners.get(event) ?? []) {
      handler({ payload });
    }
  });
}

beforeEach(() => {
  listeners.clear();
  invoked.length = 0;
  invocationArgs.length = 0;
  rejectedCommand = null;
  deferFix = false;
  rejectFix = undefined;
  deferCopy = false;
  rejectCopy = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DictationOverlay", () => {
  it("shows a completed removal without offering copy or paste actions", () => {
    render(<DictationOverlay initialEvent={{ state: "filtered", text: "", retainedAudio: false }} subscribeToEvents={false} />);
    expect(screen.getByText("Words removed")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers dictionary and Fix after dictation and sends the original transcript", async () => {
    render(<DictationOverlay initialEvent={{ state: "completed", text: "I use Larab.", retainedAudio: false }} subscribeToEvents={false} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fix" })); });
    expect(invoked.at(-1)).toBe("fix_dictation_transcript");
    expect(invocationArgs.at(-1)).toEqual({ original: "I use Larab." });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update dictionary" })); });
    expect(invoked.at(-1)).toBe("open_dictation_dictionary");
  });

  it("keeps the original transcript accessible when Fix fails", async () => {
    rejectedCommand = "fix_dictation_transcript";
    render(<DictationOverlay initialEvent={{ state: "completed", text: "Original text", retainedAudio: false }} subscribeToEvents={false} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fix" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Clipboard unavailable");
    expect(screen.getByText("Original text")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fix" })).toBeEnabled();
  });

  it("ignores an old Fix failure after a new recording starts", async () => {
    deferFix = true;
    render(<DictationOverlay initialEvent={{ state: "completed", text: "Original text", retainedAudio: false }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fix" })); });
    await emit("falcondeck://dictation-state", { state: "recording", retainedAudio: false });
    await act(async () => { rejectFix?.("Old request failed"); });
    expect(screen.getByText("Listening")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores an old Copy failure after a new recording starts", async () => {
    deferCopy = true;
    render(<DictationOverlay initialEvent={{ state: "completed", text: "Original text", retainedAudio: false }} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy transcript" }));
    await emit("falcondeck://dictation-state", { state: "recording", retainedAudio: false });
    await act(async () => { rejectCopy?.("Old clipboard request failed"); });
    expect(screen.getByText("Listening")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers a replacement paste when the fixed text cannot be inserted automatically", async () => {
    render(<DictationOverlay initialEvent={{ state: "fixed", text: "Corrected text", error: "Select the original passage first.", retainedAudio: false }} subscribeToEvents={false} />);
    expect(screen.getByText("Text fixed")).toBeInTheDocument();
    expect(screen.getByText("Corrected text")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Paste correction" })); });
    expect(invoked.at(-1)).toBe("retry_dictation_paste");
  });

  it("keeps voice rewrite completions focused on their copy action", () => {
    render(<DictationOverlay initialEvent={{ state: "completed", text: "Rewritten text", retainedAudio: false, mode: "rewrite" }} subscribeToEvents={false} />);
    expect(screen.queryByRole("button", { name: "Fix" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy rewrite" })).toBeInTheDocument();
  });

  it("retries saved audio into the clipboard and leaves the recovered text visible", async () => {
    render(<DictationOverlay />);
    await emit("falcondeck://dictation-state", {
      state: "failed", error: "A recording is waiting", retainedAudio: true,
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry transcription" })); });
    expect(invoked.at(-1)).toBe("retry_dictation");
    expect(invocationArgs.at(-1)).toEqual({ copyOnly: true });
    expect(screen.getByRole("button", { name: "Retry transcription" })).toBeDisabled();
    await emit("falcondeck://dictation-state", { state: "recovered", text: "Recovered words", retainedAudio: false });
    expect(screen.getByText("Transcript copied")).toBeInTheDocument();
    expect(screen.getByText("Recovered words")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Paste transcript" })); });
    expect(invoked.at(-1)).toBe("retry_dictation_paste");
  });

  it("offers discard without retry or a safe-audio promise for an unreadable recording", async () => {
    render(<DictationOverlay />);
    await emit("falcondeck://dictation-state", {
      state: "unrecoverable", error: "Its audio cannot be read.", retainedAudio: true,
    });
    expect(screen.getByText("Recording interrupted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry transcription" })).not.toBeInTheDocument();
    expect(screen.queryByText(/saved audio is available/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard recording" })).toBeInTheDocument();
  });

  it("prioritizes copying when the recovery clipboard write failed", async () => {
    render(<DictationOverlay initialEvent={{ state: "copy_failed", text: "Recovered words", error: "Clipboard copy failed", retainedAudio: true }} subscribeToEvents={false} />);
    expect(screen.getByText("Couldn't copy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy transcript" })).toHaveClass("text-surface-0");
    expect(screen.getByText("Recovered words")).toBeInTheDocument();
  });

  it("shows clipboard errors and keeps the transcript available", async () => {
    rejectedCommand = "copy_dictation_transcript";
    render(<DictationOverlay initialEvent={{ state: "recovered", text: "Recovered words", retainedAudio: false }} subscribeToEvents={false} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copied" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not copy");
    expect(screen.getByText("Recovered words")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy transcript" })).toBeInTheDocument();
  });

  it("offers a countdown undo after a cancelled take", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DictationOverlay />);

    await emit("falcondeck://dictation-state", {
      state: "cancelled",
      retainedAudio: true,
    });

    const undo = await screen.findByRole("button", { name: /undo/i });
    expect(undo).toHaveTextContent("10s");

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(undo).toHaveTextContent("7s");

    await act(async () => {
      fireEvent.click(undo);
    });
    expect(invoked).toContain("retry_dictation");
  });

  it("skips undo when the cancelled take kept no audio", async () => {
    render(<DictationOverlay />);

    await emit("falcondeck://dictation-state", {
      state: "cancelled",
      retainedAudio: false,
    });

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("labels a rewrite recording as listening for an edit", async () => {
    render(<DictationOverlay />);

    await emit("falcondeck://dictation-state", {
      state: "recording",
      retainedAudio: false,
      mode: "rewrite",
    });

    expect(screen.getByText("Listening for edit")).toBeInTheDocument();
    expect(screen.getByText("Esc to cancel")).toBeInTheDocument();
  });

  it("shows rewriting while the model is editing the selection", async () => {
    render(<DictationOverlay />);

    await emit("falcondeck://dictation-state", {
      state: "rewriting",
      retainedAudio: true,
      mode: "rewrite",
    });

    expect(screen.getByText("Rewriting")).toBeInTheDocument();
  });

  it("labels a rewrite completion separately from dictation", async () => {
    render(<DictationOverlay />);

    await emit("falcondeck://dictation-state", {
      state: "completed",
      text: "Ship Friday.",
      retainedAudio: false,
      mode: "rewrite",
    });

    expect(screen.getByText("Rewrite pasted")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy rewrite" }),
    ).toBeInTheDocument();
  });

  it("keeps the recording pill free of controls", async () => {
    render(<DictationOverlay />);

    await emit("falcondeck://dictation-state", {
      state: "recording",
      retainedAudio: false,
    });

    expect(screen.getByText("Listening")).toBeInTheDocument();
    expect(screen.getByText("Esc to cancel")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps a completed transcript available to copy", async () => {
    render(<DictationOverlay />);

    await emit("falcondeck://dictation-state", {
      state: "completed",
      text: "A transcript the destination may not have accepted.",
      retainedAudio: false,
    });

    const copy = screen.getByRole("button", { name: "Copy transcript" });
    await act(async () => {
      fireEvent.click(copy);
    });

    expect(invoked).toContain("copy_dictation_transcript");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("treats a ready-but-unpasted transcript as a recovery, not a quotation", async () => {
    const transcript =
      "Can we design a multi-prompt AI tool for the AI mode?";
    render(<DictationOverlay />);

    await emit("falcondeck://dictation-state", {
      state: "failed",
      text: transcript,
      error:
        "The transcript is ready, but FalconDeck could not paste it. Click Retry paste after focusing the destination, or copy it below.",
      retainedAudio: true,
    });

    expect(screen.getByText("Couldn't paste")).toBeInTheDocument();
    expect(screen.getByText(transcript)).toBeInTheDocument();
    expect(screen.queryByText(`“${transcript}”`)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry paste" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy transcript" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry paste" }),
    ).toHaveClass("text-surface-0");
    expect(
      screen.getByRole("button", { name: "Retry transcription" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard recording" }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry paste" }));
    });
    expect(invoked).toContain("retry_dictation_paste");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(invoked).toContain("dismiss_dictation_overlay");
  });

  it("renames the retry button for a failed rewrite", async () => {
    render(<DictationOverlay />);

    await emit("falcondeck://dictation-state", {
      state: "failed",
      text: "Shorter version.",
      error: "The rewrite is ready.",
      retainedAudio: true,
      mode: "rewrite",
    });

    expect(
      screen.getByRole("button", { name: "Retry paste" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy rewrite" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry rewrite" }),
    ).toBeInTheDocument();
  });
});
