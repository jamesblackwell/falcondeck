import { useCallback, useEffect, useRef, useState } from "react";

import { readDictationSettings } from "../dictation";

const DRAFT_DB = "falcondeck-speech";
const DRAFT_STORE = "recordings";
const DRAFT_KEY = "pending";

export type VoiceRecorderState =
  | "idle"
  | "recording"
  | "transcribing"
  | "failed";

type PendingRecording = { blob: Blob; format: string; model: string };

function request<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, init).then(async (response) => {
    const body = (await response.json().catch(() => null)) as
      | T
      | { error?: string }
      | null;
    if (!response.ok) {
      throw new Error(
        body && typeof body === "object" && "error" in body && body.error
          ? body.error
          : `Request failed (${response.status})`,
      );
    }
    return body as T;
  });
}

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DRAFT_DB, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(DRAFT_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readPendingRecording(): Promise<PendingRecording | null> {
  const db = await openDraftDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE, "readonly");
    const request = transaction.objectStore(DRAFT_STORE).get(DRAFT_KEY);
    request.onsuccess = () =>
      resolve((request.result as PendingRecording | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function writePendingRecording(
  recording: PendingRecording | null,
): Promise<void> {
  const db = await openDraftDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE, "readwrite");
    const store = transaction.objectStore(DRAFT_STORE);
    if (recording) store.put(recording, DRAFT_KEY);
    else store.delete(DRAFT_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

function recordingFormat(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

function preferredMimeType(): string | undefined {
  return [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ].find((type) => MediaRecorder.isTypeSupported(type));
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function useVoiceRecorder({
  baseUrl,
  onTranscript,
}: {
  baseUrl: string | null;
  onTranscript: (text: string, options: { submit: boolean }) => void;
}) {
  const [state, setState] = useState<VoiceRecorderState>("idle");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [pending, setPending] = useState<PendingRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Which control ended the recording. Transcription resolves long after the
  // click, so the intent has to outlive it.
  const submitOnFinishRef = useRef(false);
  const cancelledRef = useRef(false);
  const baseUrlRef = useRef(baseUrl);

  useEffect(() => {
    baseUrlRef.current = baseUrl;
  }, [baseUrl]);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopTracks, [stopTracks]);

  useEffect(() => {
    if (!baseUrl) return;
    void request<{ configured: boolean }>(
      `${baseUrl}/api/speech/openrouter-key`,
    )
      .then((value) => setConfigured(value.configured))
      .catch(() => {
        // Degrade quietly: an unreachable daemon must not replace the
        // composer with an error. configured stays unknown (null) and the
        // attempt surfaces any real problem when the user records.
      });
    void readPendingRecording()
      .then((recording) => {
        if (!recording) return;
        // Keep the composer usable; the preserved recording is surfaced
        // when the user next taps the mic, not at launch.
        setPending(recording);
      })
      .catch(() => {
        // A corrupt draft store must not block the composer.
      });
  }, [baseUrl]);

  useEffect(() => {
    if (state !== "recording") return;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [state]);

  // Losing the daemon mid-session must release the microphone: the stop
  // control lives in the composer, which unmounts when baseUrl goes away.
  // onstop stays attached so the recorder's final flush is assembled and
  // persisted to IndexedDB (transcribe no-ops without a daemon), keeping
  // the recording available for retry on reconnect.
  useEffect(() => {
    if (baseUrl || state === "idle") return;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      recorderRef.current = null;
    }
    stopTracks();
    setError(
      pending
        ? "The daemon disconnected. Your recording is saved — retry when it is back."
        : "The daemon disconnected.",
    );
    setState("failed");
  }, [baseUrl, pending, state, stopTracks]);

  const refreshConfigured = useCallback(async (): Promise<boolean | null> => {
    if (!baseUrl) return null;
    try {
      const value = await request<{ configured: boolean }>(
        `${baseUrl}/api/speech/openrouter-key`,
      );
      setConfigured(value.configured);
      return value.configured;
    } catch {
      return null;
    }
  }, [baseUrl]);

  const transcribe = useCallback(
    async (recording: PendingRecording) => {
      const currentBaseUrl = baseUrlRef.current;
      if (!currentBaseUrl) return;
      setState("transcribing");
      setError(null);
      try {
        const result = await request<{ text: string }>(
          `${currentBaseUrl}/api/speech/transcribe`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              audio_base64: await blobBase64(recording.blob),
              format: recording.format,
              model: recording.model,
            }),
          },
        );
        const text = result.text.trim();
        if (!text)
          throw new Error(
            "No speech was detected. Your recording is safe, so you can retry.",
          );
        await writePendingRecording(null);
        setPending(null);
        onTranscript(text, { submit: submitOnFinishRef.current });
        setState("idle");
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Transcription failed. Your recording is safe.",
        );
        setState("failed");
      }
    },
    [onTranscript],
  );

  const start = useCallback(async () => {
    // A preserved recording must be resolved (retry or discard) before a new
    // one can start; starting fresh would silently overwrite it.
    if (pending) {
      setError("A previous recording is waiting to be transcribed.");
      setState("failed");
      return;
    }
    // Re-check credentials unless already confirmed so a key saved in Speech
    // settings takes effect immediately. Only an explicit "no key" blocks;
    // an unreachable daemon (null) records optimistically and the transcribe
    // call reports the real problem with the recording safely preserved.
    const isConfigured =
      configured === true ? true : await refreshConfigured();
    if (isConfigured === false) {
      setError("Add an OpenRouter API key in Speech settings first.");
      setState("failed");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;
      setSeconds(0);
      setError(null);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopTracks();
        // A cancelled take is thrown away deliberately: persisting it would
        // block the next recording behind a "pending recording" prompt for
        // audio the user just said they did not want.
        if (cancelledRef.current) {
          chunksRef.current = [];
          setState("idle");
          return;
        }
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const recording = {
          blob,
          format: recordingFormat(recorder.mimeType),
          model: readDictationSettings().model,
        };
        setPending(recording);
        void writePendingRecording(recording)
          .then(() => transcribe(recording))
          .catch((cause) => {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not preserve the recording.",
            );
            setState("failed");
          });
      };
      recorder.start(500);
      setState("recording");
    } catch (cause) {
      stopTracks();
      setError(
        cause instanceof Error ? cause.message : "Could not access the microphone.",
      );
      setState("failed");
    }
  }, [configured, pending, refreshConfigured, stopTracks, transcribe]);

  const stop = useCallback((options?: { submit?: boolean }) => {
    submitOnFinishRef.current = options?.submit === true;
    recorderRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      // onstop releases the microphone and drops the chunks.
      recorder.stop();
    } else {
      stopTracks();
      setState("idle");
    }
    setError(null);
  }, [stopTracks]);

  const discard = useCallback(async () => {
    await writePendingRecording(null);
    setPending(null);
    setError(null);
    setState("idle");
  }, []);

  const retry = useCallback(async () => {
    submitOnFinishRef.current = false;
    const recording = pending
      ? { ...pending, model: readDictationSettings().model }
      : null;
    if (!recording) return;
    setPending(recording);
    await writePendingRecording(recording);
    await transcribe(recording);
  }, [pending, transcribe]);

  const dismiss = useCallback(() => {
    setError(null);
    setState("idle");
  }, []);

  return {
    state,
    seconds,
    error,
    configured,
    hasPending: pending !== null,
    start,
    stop,
    cancel,
    discard,
    retry,
    dismiss,
  };
}
