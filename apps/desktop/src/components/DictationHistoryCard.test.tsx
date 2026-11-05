import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DictationHistoryCard } from "./DictationHistoryCard";
import {
  formatRecordedAt,
  formatRecordingLength,
  retentionSummary,
  transcriptionEngineLabel,
} from "./dictation-history-utils";
import {
  DEFAULT_DICTATION_SETTINGS,
  writeDictationSettings,
  type DictationHistoryEntry,
} from "../dictation";

const invocations: Array<{ command: string; args: unknown }> = [];
let history: DictationHistoryEntry[] = [];
let retryResult: (() => DictationHistoryEntry) | null = null;
let parakeetInstalled = false;

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
      case "parakeet_status":
        return Promise.resolve({
          supported: true,
          installed: parakeetInstalled,
          loaded: false,
          busy: false,
          progress: null,
          phase: "",
          error: null,
        });
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
    attemptProvider: null,
    text: null,
    error: "OpenRouter is rate limited",
    audioAvailable: true,
    captureCorrupted: false,
    rawCaptureAvailable: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  stateListeners.clear();
  invocations.length = 0;
  history = [];
  retryResult = null;
  parakeetInstalled = false;
  window.__TAURI_INTERNALS__ = {} as never;
  writeDictationSettings(DEFAULT_DICTATION_SETTINGS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  window.localStorage.clear();
});

const CLOUD_PARAKEET = "nvidia/parakeet-tdt-0.6b-v3";

function retryCalls() {
  return invocations.filter((call) => call.command === "dictation_history_retry");
}

describe("transcriptionEngineLabel", () => {
  it("tells cloud and local Parakeet apart although they share a model id", () => {
    expect(transcriptionEngineLabel({ provider: "open_router", model: CLOUD_PARAKEET, attemptProvider: null })).toBe(`OpenRouter: ${CLOUD_PARAKEET}`);
    expect(transcriptionEngineLabel({ provider: "parakeet", model: CLOUD_PARAKEET, attemptProvider: null })).toBe("Parakeet on this Mac");
  });

  it("follows the engine of the latest attempt, not the recording's provider", () => {
    expect(transcriptionEngineLabel({ provider: "open_router", model: CLOUD_PARAKEET, attemptProvider: "parakeet" })).toBe("Parakeet on this Mac");
    expect(transcriptionEngineLabel({ provider: "parakeet", model: CLOUD_PARAKEET, attemptProvider: "open_router" })).toBe(`OpenRouter: ${CLOUD_PARAKEET}`);
  });

  it("names Apple Speech and a cloud take without a model", () => {
    expect(transcriptionEngineLabel({ provider: "system", model: null, attemptProvider: null })).toBe("Apple Speech");
    expect(transcriptionEngineLabel({ provider: "open_router", model: null, attemptProvider: null })).toBe("OpenRouter");
  });
});

describe("DictationHistoryCard", () => {
  it("offers local Parakeet for a cloud recording and retries it without the daemon", async () => {
    parakeetInstalled = true;
    history = [entry({ provider: "open_router", model: CLOUD_PARAKEET })];
    retryResult = () => ({ ...history[0], attemptProvider: "parakeet", text: "Local transcript", error: null });
    render(<DictationHistoryCard baseUrl={null} onToast={() => {}} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry).toBeDisabled();
    fireEvent.change(await screen.findByLabelText("Retry using"), { target: { value: "local:parakeet" } });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(retryCalls()).toEqual([{ command: "dictation_history_retry", args: { id: history[0].id, model: null, engine: "parakeet", force: null } }]));
    expect(await screen.findByText("Parakeet on this Mac")).toBeInTheDocument();
  });

  it("never turns a local choice into a cloud retry when the model is removed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      parakeetInstalled = true;
      history = [entry({ provider: "open_router", model: CLOUD_PARAKEET })];
      render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
      await screen.findByRole("option", { name: "Parakeet on this Mac (local)" });
      fireEvent.change(screen.getByLabelText("Retry using"), { target: { value: "local:parakeet" } });
      parakeetInstalled = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(screen.getByLabelText("Retry using")).toHaveValue("local:parakeet");
      expect(screen.getByRole("option", { name: "Parakeet on this Mac (not downloaded)" })).toBeInTheDocument();
      expect(retry).toBeDisabled();
      fireEvent.click(retry);
      expect(retryCalls()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not offer local Parakeet until it is installed", async () => {
    history = [entry()];
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
    await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => expect(invocations.some((call) => call.command === "parakeet_status")).toBe(true));
    expect(screen.queryByRole("option", { name: "Parakeet on this Mac (local)" })).not.toBeInTheDocument();
  });

  it("keeps cloud retries on the cloud route when local Parakeet is installed", async () => {
    parakeetInstalled = true;
    history = [entry({ model: "openai/whisper-large-v3-turbo:nitro" })];
    writeDictationSettings({ ...DEFAULT_DICTATION_SETTINGS, model: "cloud/preferred" });
    retryResult = () => ({ ...history[0], text: "Cloud transcript", error: null });
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
    await screen.findByRole("option", { name: "Parakeet on this Mac (local)" });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retryCalls()).toEqual([{ command: "dictation_history_retry", args: { id: history[0].id, model: "cloud/preferred", engine: null, force: null } }]));
  });

  it("labels the text beside a failed retry as an earlier attempt", async () => {
    history = [entry({ model: CLOUD_PARAKEET, text: "So, let's go. So", error: "Parakeet found no speech" })];
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
    expect(await screen.findByText("This retry failed: Parakeet found no speech")).toBeInTheDocument();
    expect(screen.getByText("Earlier attempt, not a confirmed result")).toBeInTheDocument();
    expect(screen.getByText("So, let's go. So")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy earlier attempt" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy transcript" })).not.toBeInTheDocument();
  });

  it("shows a plain failure when there was no earlier transcript", async () => {
    history = [entry()];
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
    expect(await screen.findByText("OpenRouter is rate limited")).toBeInTheDocument();
    expect(screen.queryByText("Earlier attempt, not a confirmed result")).not.toBeInTheDocument();
  });

  it("lets a corrupted recording be tried anyway, only on this Mac", async () => {
    parakeetInstalled = true;
    history = [entry({ error: "Corrupted.", captureCorrupted: true })];
    retryResult = () => ({ ...history[0], attemptProvider: "parakeet", text: "It was fine", error: null, captureCorrupted: false });
    render(<DictationHistoryCard baseUrl={null} onToast={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try anyway" }));
    await waitFor(() => expect(retryCalls()).toEqual([{ command: "dictation_history_retry", args: { id: history[0].id, model: null, engine: "parakeet", force: true } }]));
    expect(await screen.findByText("It was fine")).toBeInTheDocument();
    expect(screen.queryByText("Recording corrupted")).not.toBeInTheDocument();
  });

  it("offers no way to try a corrupted recording without local Parakeet", async () => {
    history = [entry({ error: "Corrupted.", captureCorrupted: true })];
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
    expect(await screen.findByText("Recording corrupted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try anyway" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("keeps Default retry local for an Apple take while Voice is Parakeet", async () => {
    writeDictationSettings({ ...DEFAULT_DICTATION_SETTINGS, provider: "parakeet", model: "cloud/preferred" });
    history = [entry({ provider: "system", model: null })];
    retryResult = () => ({ ...history[0], attemptProvider: "parakeet", text: "Local", error: null });
    render(<DictationHistoryCard baseUrl={null} onToast={() => {}} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    // Named outright: Rust's copy of the Voice setting may have been rejected.
    await waitFor(() => expect(retryCalls()).toEqual([{ command: "dictation_history_retry", args: { id: history[0].id, model: null, engine: "parakeet", force: null } }]));
  });

  it("lets a chosen cloud model override Voice being Parakeet", async () => {
    writeDictationSettings({ ...DEFAULT_DICTATION_SETTINGS, provider: "parakeet", model: "cloud/preferred" });
    history = [entry({ provider: "system", model: null })];
    retryResult = () => ({ ...history[0], attemptProvider: "open_router", text: "Cloud", error: null });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify([{ id: "cloud/other", name: "Other" }])));
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
    await screen.findByRole("option", { name: "Other" });
    fireEvent.change(await screen.findByLabelText("Retry using"), { target: { value: "cloud/other" } });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retryCalls()).toEqual([{ command: "dictation_history_retry", args: { id: history[0].id, model: "cloud/other", engine: null, force: null } }]));
  });

  it("says transcript cleanup still uses OpenRouter when the audio stays local", async () => {
    history = [entry()];
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
    expect(await screen.findByText(/transcript cleanup still sends the text to OpenRouter/)).toBeInTheDocument();
  });

  it("offers no retry for a corrupted recording and says the raw capture is kept", async () => {
    parakeetInstalled = true;
    history = [entry({ error: "The recording looks corrupted, so no transcription engine can read it.", captureCorrupted: true, rawCaptureAvailable: true })];
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
    expect(await screen.findByText("The recording looks corrupted, so no transcription engine can read it.")).toBeInTheDocument();
    expect(screen.getByText("Recording corrupted")).toBeInTheDocument();
    expect(screen.getByText(/The raw capture stays on this Mac/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("marks a repaired take without calling it damaged", async () => {
    history = [entry({ error: null, text: "Recovered words", rawCaptureAvailable: true })];
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:1" onToast={() => {}} />);
    expect(await screen.findByText("Recovered capture")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("retries Parakeet locally without a daemon connection or cloud model override", async () => {
    history = [entry({ provider: "parakeet", model: "nvidia/parakeet-tdt-0.6b-v3" })];
    retryResult = () => ({ ...history[0], text: "Local transcript", error: null });
    render(<DictationHistoryCard baseUrl={null} onToast={() => {}} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(invocations.find(call => call.command === "dictation_history_retry")).toEqual({ command: "dictation_history_retry", args: { id: history[0].id, model: null, engine: null, force: null } }));
  });
  it("retries a Whisper fallback with the preferred cloud model", async () => {
    history = [entry({ model: "openai/whisper-large-v3-turbo:nitro", text: "So" })];
    writeDictationSettings({ ...DEFAULT_DICTATION_SETTINGS, model: "nvidia/parakeet-tdt-0.6b-v3", fallbackModel: "openai/whisper-large-v3-turbo" });
    render(<DictationHistoryCard baseUrl="http://127.0.0.1:4123" onToast={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(invocations.find(call => call.command === "dictation_history_retry")).toEqual({ command: "dictation_history_retry", args: { id: history[0].id, model: "nvidia/parakeet-tdt-0.6b-v3", engine: null, force: null } }));
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
        // Retry starts over with the preferred model, even after a fallback.
        model: DEFAULT_DICTATION_SETTINGS.model,
        engine: null,
        force: null,
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
