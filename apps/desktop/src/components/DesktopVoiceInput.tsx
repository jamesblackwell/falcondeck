import { useCallback, useEffect, useRef, useState } from "react";

import {
  ActivityDiamond,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@falcondeck/ui";
import { Mic, RotateCcw, Square, Trash2, X } from "lucide-react";

const DEFAULT_MODEL = "openai/gpt-transcribe";
const MODEL_STORAGE_KEY = "falcondeck:speech-model";
const DRAFT_DB = "falcondeck-speech";
const DRAFT_STORE = "recordings";
const DRAFT_KEY = "pending";

type SpeechModel = { id: string; name: string };
type PendingRecording = { blob: Blob; format: string; model: string };
type RecorderState = "ready" | "recording" | "transcribing" | "failed";

function request<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, init).then(async (response) => {
    const body = (await response.json().catch(() => null)) as
      T | { error?: string } | null;
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

export function DesktopVoiceInput({
  baseUrl,
  onTranscript,
  onClose,
  onOpenSettings,
}: {
  baseUrl: string;
  onTranscript: (text: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [state, setState] = useState<RecorderState>("ready");
  const [models, setModels] = useState<SpeechModel[]>([]);
  const [model, setModel] = useState(
    () => localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL,
  );
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [pending, setPending] = useState<PendingRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopTracks, [stopTracks]);

  useEffect(() => {
    void request<{ configured: boolean }>(
      `${baseUrl}/api/speech/openrouter-key`,
    )
      .then((value) => setConfigured(value.configured))
      .catch((cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not read speech settings.",
        );
        setState("failed");
      });
    void request<SpeechModel[]>(`${baseUrl}/api/speech/models`)
      .then(setModels)
      .catch(() => {
        // The saved/default model remains usable when model discovery is offline.
        setModels([]);
      });
    void readPendingRecording()
      .then((recording) => {
        if (!recording) return;
        setPending(recording);
        setModel(recording.model);
        setError("A previous recording is waiting to be transcribed.");
        setState("failed");
      })
      .catch((cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not restore the saved recording.",
        );
        setState("failed");
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

  const transcribe = useCallback(
    async (recording: PendingRecording) => {
      setState("transcribing");
      setError(null);
      try {
        const result = await request<{ text: string }>(
          `${baseUrl}/api/speech/transcribe`,
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
        onTranscript(text);
        onClose();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Transcription failed. Your recording is safe.",
        );
        setState("failed");
      }
    },
    [baseUrl, onClose, onTranscript],
  );

  const start = async () => {
    if (!configured) {
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
      setSeconds(0);
      setError(null);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopTracks();
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const recording = {
          blob,
          format: recordingFormat(recorder.mimeType),
          model,
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
        cause instanceof Error
          ? cause.message
          : "Could not access the microphone.",
      );
      setState("failed");
    }
  };

  const stop = () => recorderRef.current?.stop();
  const discard = async () => {
    await writePendingRecording(null);
    setPending(null);
    onClose();
  };
  const retry = async () => {
    if (!pending) return;
    const recording = { ...pending, model };
    setPending(recording);
    await writePendingRecording(recording);
    await transcribe(recording);
  };
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Voice input"
    >
      <Card className="w-full max-w-md shadow-2xl">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Voice input</CardTitle>
              <CardDescription>
                Your recording stays on this Mac until transcription succeeds.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              className="h-8 w-8 p-0"
              onClick={onClose}
              disabled={state === "recording" || state === "transcribing"}
              aria-label="Close voice input"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block space-y-1 text-[length:var(--fd-text-sm)] text-fg-secondary">
            <span>Transcription model</span>
            <select
              className="w-full rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 px-3 py-2 text-fg-primary"
              value={model}
              disabled={state === "recording" || state === "transcribing"}
              onChange={(event) => {
                setModel(event.target.value);
                localStorage.setItem(MODEL_STORAGE_KEY, event.target.value);
              }}
            >
              {!models.some((item) => item.id === model) ? (
                <option value={model}>{model}</option>
              ) : null}
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex min-h-28 flex-col items-center justify-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-5 text-center">
            {state === "recording" ? (
              <>
                <Mic className="h-8 w-8 text-danger" />
                <div className="font-mono text-xl text-fg-primary">
                  {duration}
                </div>
                <span className="text-sm text-fg-muted">Recording…</span>
              </>
            ) : null}
            {state === "transcribing" ? (
              <>
                <ActivityDiamond size="lg" />
                <span className="text-sm text-fg-muted">
                  Transcribing securely on this Mac…
                </span>
              </>
            ) : null}
            {state === "ready" ? (
              <>
                <Mic className="h-8 w-8 text-fg-muted" />
                <span className="text-sm text-fg-muted">Ready to record</span>
              </>
            ) : null}
            {state === "failed" ? (
              <span className="text-sm text-danger">{error}</span>
            ) : null}
          </div>

          {configured === false ? (
            <Button variant="ghost" className="w-full" onClick={onOpenSettings}>
              Open Speech settings
            </Button>
          ) : null}
          <div className="flex justify-end gap-2">
            {pending && state === "failed" ? (
              <Button variant="ghost" onClick={() => void discard()}>
                <Trash2 className="h-4 w-4" />
                Discard
              </Button>
            ) : null}
            {pending && state === "failed" ? (
              <Button onClick={() => void retry()}>
                <RotateCcw className="h-4 w-4" />
                Retry
              </Button>
            ) : null}
            {!pending && state === "failed" && configured ? (
              <Button onClick={() => void start()}>
                <Mic className="h-4 w-4" />
                Try recording again
              </Button>
            ) : null}
            {state === "ready" ? (
              <Button
                onClick={() => void start()}
                disabled={configured !== true}
              >
                <Mic className="h-4 w-4" />
                Start recording
              </Button>
            ) : null}
            {state === "recording" ? (
              <Button onClick={stop}>
                <Square className="h-3.5 w-3.5 fill-current" />
                Stop and transcribe
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
