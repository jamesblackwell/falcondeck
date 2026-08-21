import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVoiceRecorder } from "./useVoiceRecorder";

/** Minimal MediaRecorder stand-in: jsdom ships neither it nor getUserMedia. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;

  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor() {
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}

/**
 * In-memory stand-in for the draft store. jsdom has no IndexedDB, and the
 * recording is persisted before it is transcribed, so without this every stop
 * lands in the "could not preserve the recording" branch.
 */
function fakeIndexedDb() {
  const records = new Map<string, unknown>();
  const settle = (target: Record<string, unknown>, event: string) =>
    queueMicrotask(() => (target[event] as (() => void) | null)?.());

  return {
    records,
    open() {
      const request: Record<string, unknown> = { result: null };
      queueMicrotask(() => {
        request.result = {
          createObjectStore: () => undefined,
          close: () => undefined,
          transaction: () => {
            const transaction: Record<string, unknown> = {
              objectStore: () => ({
                get: (key: string) => {
                  const read: Record<string, unknown> = {
                    result: records.get(key),
                  };
                  settle(read, "onsuccess");
                  return read;
                },
                put: (value: unknown, key: string) => records.set(key, value),
                delete: (key: string) => records.delete(key),
              }),
            };
            settle(transaction, "oncomplete");
            return transaction;
          },
        };
        (request.onupgradeneeded as (() => void) | null)?.();
        (request.onsuccess as (() => void) | null)?.();
      });
      return request;
    },
  };
}

const stopTrack = vi.fn();

describe("useVoiceRecorder", () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    stopTrack.mockClear();
    vi.stubGlobal("indexedDB", fakeIndexedDb());
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: stopTrack }],
          getAudioTracks: () => [
            { applyConstraints: vi.fn(async () => undefined) },
          ],
        })),
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ configured: true, text: "ship it" }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function startRecording(onTranscript = vi.fn()) {
    const view = renderHook(() =>
      useVoiceRecorder({ baseUrl: "http://localhost:1", onTranscript }),
    );
    await act(async () => {
      await view.result.current.start();
    });
    expect(view.result.current.state).toBe("recording");
    return { view, onTranscript };
  }

  it("carries the send intent through transcription", async () => {
    const { view, onTranscript } = await startRecording();

    await act(async () => {
      view.result.current.stop({ submit: true });
    });

    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith("ship it", { submit: true }),
    );
  });

  it("leaves a plain stop for the user to edit", async () => {
    const { view, onTranscript } = await startRecording();

    await act(async () => {
      view.result.current.stop();
    });

    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith("ship it", { submit: false }),
    );
  });

  it("cancelling releases the microphone and transcribes nothing", async () => {
    const { view, onTranscript } = await startRecording();

    await act(async () => {
      view.result.current.cancel();
    });

    expect(stopTrack).toHaveBeenCalled();
    expect(view.result.current.state).toBe("idle");
    expect(view.result.current.hasPending).toBe(false);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("opens the microphone without echo cancellation so playback can continue", async () => {
    await startRecording();
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<
      typeof vi.fn
    >;
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    });
  });
});
