import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DictationOverlay } from "./DictationOverlay";

type Handler = (message: { payload: unknown }) => void;

const listeners = new Map<string, Set<Handler>>();
const invoked: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Handler) => {
    const handlers = listeners.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    listeners.set(event, handlers);
    return Promise.resolve(() => handlers.delete(handler));
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    invoked.push(command);
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
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DictationOverlay", () => {
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
