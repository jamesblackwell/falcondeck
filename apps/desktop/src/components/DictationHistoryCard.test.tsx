import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DictationHistoryCard } from "./DictationHistoryCard";
import {
  formatRecordedAt,
  formatRecordingLength,
  retentionSummary,
} from "./dictation-history-utils";
import {
  DEFAULT_DICTATION_SETTINGS,
  writeDictationSettings,
  type DictationHistoryEntry,
} from "../dictation";

const invocations: Array<{ command: string; args: unknown }> = [];
let history: DictationHistoryEntry[] = [];
let retryResult: (() => DictationHistoryEntry) | null = null;

type StateHandler = () => void;
const stateListeners = new Set<StateHandler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: StateHandler) => {
    if (event === "falcondeck://dictation-history-changed") stateListeners.add(handler);
    return Promise.resolve(() => stateListeners.delete(handler));
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => {
    invocations.push({ command, args });
    switch (command) {
      case "dictation_history":
        return Promise.resolve(history);
      case "dictation_history_retry":
        return retryResult
          ? Promise.resolve(retryResult())
          : Promise.reject(new Error("Deepgram is rate limited"));
      default:
        return Promise.resolve();
    }
  },
}));

function entry(overrides: Partial<DictationHistoryEntry> = {}) {
  return {
    id: "falcondeck-dictation-abc",
    path: "/tmp/falcondeck-dictation-abc.m4a",
    recordedAtMs: Date.now() - 5 * 60_000,
    durationSeconds: 42,
    bytes: 168_000,
    provider: "open_router" as const,
    model: "openai/gpt-4o-mini-transcribe",
    text: null,
    error: "OpenRouter is rate limited",
    audioAvailable: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  stateListeners.clear();
  invocations.length = 0;
  history = [];
  retryResult = null;
  window.__TAURI_INTERNALS__ = {} as never;
  writeDictationSettings(DEFAULT_DICTATION_SETTINGS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

describe("DictationHistoryCard", () => {
  it("retries Parakeet locally without a daemon connection or cloud model override", async () => {
    history = [entry({ provider: "parakeet", model: "nvidia/parakeet-tdt-0.6b-v3" })];
    retryResult = () => ({ ...history[0], text: "Local transcript", error: null });
    render(<DictationHistoryCard baseUrl={null} onToast={() => {}} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(invocations.find(call => call.command === "dictation_history_retry")).toEqual({ command: "dictation_history_retry", args: { id: history[0].id, model: null } }));
  });
  it("says how long recordings are kept, and says so plainly when they are not", () => {
    expect(retentionSummary(6)).toContain("6 hours");
    expect(retentionSummary(1)).toContain("an hour");
    expect(retentionSummary(0)).toContain("deleted as soon as");
  });

  it("formats a recording's length and age for a quick scan", () => {
    expect(formatRecordingLength(42)).toBe("0:42");
    expect(formatRecordingLength(605)).toBe("10:05");
    const now = Date.now();
    expect(formatRecordedAt(now - 30_000, now)).toBe("Just now");
    expect(formatRecordedAt(now - 12 * 60_000, now)).toBe("12 min ago");
    expect(formatRecordedAt(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(formatRecordedAt(now - 3 * 60 * 60_000, now)).toBe("3 hours ago");
  });

  it("retries a failed recording with the chosen model and shows the new transcript", async () => {
    history = [entry()];
    retryResult = () =>
      entry({
        model: "mistralai/voxtral-mini-transcribe",
        text: "the sentence I actually said",
        error: null,
      });
    const onToast = vi.fn();
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:4123" onToast={onToast} />);

    await screen.findByText("OpenRouter is rate limited");
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await screen.findByText("the sentence I actually said");
    expect(screen.getByRole("button", { name: "Copy transcript" })).toBeEnabled();
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("the sentence I actually said"));
    expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Transcript copied" }));
    expect(
      invocations.find((call) => call.command === "dictation_history_retry"),
    ).toEqual({
      command: "dictation_history_retry",
      args: {
        id: "falcondeck-dictation-abc",
        // Retrying defaults to the fallback model, not the one that just failed.
        model: DEFAULT_DICTATION_SETTINGS.fallbackModel,
      },
    });
  });

  it("treats a transcript emptied by removal rules as success without changing the clipboard", async () => {
    history = [entry()];
    retryResult = () => entry({ text: "", error: null });
    const onToast = vi.fn();
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:4123" onToast={onToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Words removed", variant: "success" })));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Copy transcript" })).not.toBeInTheDocument();
    expect(screen.getByText("Words removed by dictionary")).toBeInTheDocument();
  });

  it("keeps successful retry text available when automatic clipboard copy fails", async () => {
    history = [entry()];
    retryResult = () => entry({ text: "Recovered despite clipboard failure", error: null });
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("Denied"));
    const onToast = vi.fn();
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:4123" onToast={onToast} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Recovered despite clipboard failure");
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Transcript ready", variant: "warning" })));
    expect(screen.getByRole("button", { name: "Copy transcript" })).toBeEnabled();
  });

  it("surfaces a failed retry instead of pretending the transcript changed", async () => {
    history = [entry()];
    const onToast = vi.fn();
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:4123" onToast={onToast} />);

    await screen.findByText("OpenRouter is rate limited");
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "danger" }),
      ),
    );
  });

  it("cannot retry a recording whose audio is already gone", async () => {
    history = [entry({ audioAvailable: false, text: "kept transcript" })];
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:4123" onToast={vi.fn()} />);

    await screen.findByText("kept transcript");
    expect(screen.getByRole("button", { name: /Retry/ })).toBeDisabled();
    expect(screen.getByText("Audio deleted")).toBeInTheDocument();
  });

  it("hides the list entirely when history is switched off", async () => {
    history = [entry()];
    writeDictationSettings({
      ...DEFAULT_DICTATION_SETTINGS,
      historyRetentionHours: 0,
    });
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:4123" onToast={vi.fn()} />);

    expect(
      screen.getByText(/deleted as soon as a transcript is pasted/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        invocations.some((call) => call.command === "dictation_history"),
      ).toBe(true),
    );
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("refreshes the list after native history filing finishes", async () => {
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:4123" onToast={vi.fn()} />);
    await waitFor(() => expect(stateListeners.size).toBe(1));

    history = [entry({ text: "fresh dictation", error: null })];
    for (const handler of stateListeners) {
      handler();
    }
    await screen.findByText("fresh dictation");
  });

  it("deletes every kept recording on request", async () => {
    history = [entry({ text: "something" })];
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:4123" onToast={vi.fn()} />);

    await screen.findByText("something");
    fireEvent.click(screen.getByRole("button", { name: /Delete all/ }));

    await waitFor(() =>
      expect(
        invocations.some((call) => call.command === "dictation_history_clear"),
      ).toBe(true),
    );
    expect(screen.queryByText("something")).toBeNull();
  });
});
