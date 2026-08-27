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
      retainedAudio: false,
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
    expect(invoked).toContain("restart_dictation");
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
});
