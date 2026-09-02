import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Button } from "@falcondeck/ui";
import { Check, Copy, Mic, RotateCcw, Trash2, X } from "lucide-react";

type DictationState =
  | "recording"
  | "transcribing"
  | "rewriting"
  | "completed"
  | "failed"
  | "cancelled";

export type DictationEvent = {
  state: DictationState;
  text?: string;
  error?: string;
  retainedAudio: boolean;
  mode?: "rewrite" | "dictation";
};

type DictationOverlayProps = {
  initialEvent?: DictationEvent;
  subscribeToEvents?: boolean;
};

// The window is created hidden and only shown alongside a real event, but if
// a frame ever renders before the first event arrives, "Transcribing" is the
// honest placeholder rather than a fake "Listening".
const INITIAL_EVENT: DictationEvent = {
  state: "transcribing",
  retainedAudio: false,
};

const LEVEL_EVENT = "falcondeck://dictation-level";
// Mirrors CANCEL_UNDO_WINDOW in dictation.rs, which hides the window when it
// runs out. Counting the same span down here keeps the deadline visible.
const UNDO_WINDOW_SECONDS = 10;
const SAMPLE_INTERVAL_MS = 45;
const MAX_SAMPLES = 180;

function LiveWaveform() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    let animationFrame = 0;
    let latestLevel = 0;
    let displayedLevel = 0;
    let lastSampleAt = 0;
    let width = 0;
    let height = 0;
    let color = "currentColor";
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const samples: number[] = [];
    // Bars only change when a sample lands (every SAMPLE_INTERVAL_MS) or the
    // canvas resizes; skipping the identical frames in between keeps the
    // always-running overlay cheap.
    let needsRedraw = true;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      width = bounds.width;
      height = bounds.height;
      color = getComputedStyle(canvas).color;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.setTransform(scale, 0, 0, scale, 0, 0);
      needsRedraw = true;
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    const draw = (timestamp: number) => {
      if (timestamp - lastSampleAt >= SAMPLE_INTERVAL_MS) {
        displayedLevel += (latestLevel - displayedLevel) * 0.55;
        latestLevel *= 0.82;
        samples.push(Math.max(0.025, displayedLevel));
        if (samples.length > MAX_SAMPLES) samples.shift();
        lastSampleAt = timestamp;
        needsRedraw = true;
      }
      if (!needsRedraw) {
        if (!reduceMotion) {
          animationFrame = window.requestAnimationFrame(draw);
        }
        return;
      }
      needsRedraw = false;

      context.clearRect(0, 0, width, height);
      const slotWidth = 6;
      const barCount = Math.max(1, Math.floor(width / slotWidth));
      const firstSample = Math.max(0, samples.length - barCount);
      const visibleSamples = samples.slice(firstSample);
      const leadingBars = barCount - visibleSamples.length;
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.lineCap = "round";

      for (let index = 0; index < barCount; index += 1) {
        const level =
          index < leadingBars
            ? 0.025
            : (visibleSamples[index - leadingBars] ?? 0.025);
        const barHeight = 3 + level * Math.max(0, height - 5);
        const x = index * slotWidth + slotWidth / 2;
        context.globalAlpha = 0.28 + (index / barCount) * 0.72;
        context.beginPath();
        context.moveTo(x, (height - barHeight) / 2);
        context.lineTo(x, (height + barHeight) / 2);
        context.stroke();
      }
      context.globalAlpha = 1;
      if (!reduceMotion) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    animationFrame = window.requestAnimationFrame(draw);
    void listen<number>(LEVEL_EVENT, (message) => {
      latestLevel = Math.max(0, Math.min(1, message.payload));
    }).then((nextUnlisten) => {
      if (cancelled) nextUnlisten();
      else unlisten = nextUnlisten;
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      unlisten?.();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="h-9 min-w-0 flex-1 text-accent"
      role="img"
      aria-label="Live microphone level"
    />
  );
}

export function DictationOverlay({
  initialEvent = INITIAL_EVENT,
  subscribeToEvents = true,
}: DictationOverlayProps = {}) {
  const [event, setEvent] = useState<DictationEvent>(initialEvent);
  const [copied, setCopied] = useState(false);
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(UNDO_WINDOW_SECONDS);

  useEffect(() => {
    setCopied(false);
  }, [event]);

  // Wall-clock rather than a tick count, so a throttled timer cannot promise
  // more time than the window actually has left.
  useEffect(() => {
    if (event.state !== "cancelled" || !event.retainedAudio) return;
    setUndoSecondsLeft(UNDO_WINDOW_SECONDS);
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setUndoSecondsLeft(Math.max(0, UNDO_WINDOW_SECONDS - elapsed));
    }, 250);
    return () => window.clearInterval(interval);
  }, [event]);

  useEffect(() => {
    if (!subscribeToEvents) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<DictationEvent>("falcondeck://dictation-state", (message) => {
      setEvent(message.payload);
    }).then((nextUnlisten) => {
      if (cancelled) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [subscribeToEvents]);

  const failed = event.state === "failed";
  const pasteFailed = failed && Boolean(event.text);
  const copyTranscript = () => {
    void invoke("copy_dictation_transcript").then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  const rewrite = event.mode === "rewrite";
  const label =
    event.state === "recording"
      ? rewrite
        ? "Listening for edit"
        : "Listening"
      : event.state === "transcribing"
        ? rewrite
          ? "Transcribing instruction"
          : "Transcribing"
        : event.state === "rewriting"
          ? "Rewriting"
          : event.state === "completed"
            ? rewrite
              ? "Rewrite pasted"
              : "Paste sent"
            : event.state === "cancelled"
              ? "Cancelled"
              : pasteFailed
                ? "Couldn't paste"
                : rewrite
                  ? "Rewrite needs attention"
                  : "Dictation needs attention";

  return (
    <main className="flex h-full w-full items-stretch justify-center p-2">
      <section
        className={
          failed
            ? "flex h-full min-h-0 w-full flex-col overflow-y-auto rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1/95 px-4 py-3 backdrop-blur-xl"
            : "flex h-14 w-full items-center gap-3 rounded-full border border-border-default bg-surface-1/95 px-4 backdrop-blur-xl"
        }
        role="status"
        aria-live="polite"
      >
        {failed ? (
          <>
            <div className="flex min-h-0 flex-1 items-start gap-3">
              <span className="mt-0.5 rounded-full bg-danger-muted p-1.5 text-danger">
                <X aria-hidden="true" className="h-4 w-4" />
              </span>
              <div className="min-h-0 min-w-0 flex-1">
                <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  {label}
                </p>
                <p className="mt-0.5 line-clamp-2 text-[length:var(--fd-text-xs)] text-fg-muted">
                  {event.error}
                </p>
                {event.text ? (
                  <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words rounded-[var(--fd-radius-md)] bg-surface-2 px-2 py-1.5 text-[length:var(--fd-text-xs)] text-fg-primary">
                    {event.text}
                  </p>
                ) : null}
                {event.retainedAudio ? (
                  <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-tertiary">
                    Your recording is safe until you retry or discard it.
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="-mr-1 -mt-1 shrink-0"
                aria-label="Close"
                onClick={() => void invoke("dismiss_dictation_overlay")}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-3 flex shrink-0 flex-wrap justify-end gap-2">
              {event.text ? (
                <Button
                  type="button"
                  onClick={copyTranscript}
                >
                  {copied ? (
                    <Check aria-hidden="true" className="h-4 w-4" />
                  ) : (
                    <Copy aria-hidden="true" className="h-4 w-4" />
                  )}
                  {copied ? "Copied" : rewrite ? "Copy rewrite" : "Copy transcript"}
                </Button>
              ) : null}
              {event.retainedAudio ? (
                <Button
                  type="button"
                  variant={event.text ? "secondary" : "default"}
                  onClick={() => void invoke("retry_dictation")}
                >
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                  {rewrite ? "Retry rewrite" : "Retry transcription"}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                className="hover:text-danger"
                aria-label={
                  event.retainedAudio ? "Discard recording" : "Dismiss"
                }
                onClick={() => void invoke("discard_dictation")}
              >
                {event.retainedAudio ? (
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                ) : (
                  <X aria-hidden="true" className="h-4 w-4" />
                )}
                {event.retainedAudio ? "Discard recording" : "Dismiss"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 text-fg-primary">
              {event.state === "recording" ? (
                <Mic aria-hidden="true" className="h-4 w-4" />
              ) : event.state === "completed" ? (
                <Check aria-hidden="true" className="h-4 w-4 text-success" />
              ) : event.state === "cancelled" ? (
                <X aria-hidden="true" className="h-4 w-4 text-fg-muted" />
              ) : (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-fg-muted border-t-accent" />
              )}
            </span>
            <span className="min-w-24 text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
              {label}
            </span>
            {event.state === "recording" ? <LiveWaveform /> : null}
            {event.state === "cancelled" && event.retainedAudio ? (
              <button
                type="button"
                className="fd-focus ml-auto inline-flex shrink-0 items-center gap-2 rounded-full border border-border-default px-3 py-1.5 text-[length:var(--fd-text-xs)] font-medium text-fg-primary hover:bg-surface-3"
                onClick={() => void invoke("retry_dictation")}
              >
                <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                Undo
                <span className="font-mono text-fg-muted">
                  {undoSecondsLeft}s
                </span>
              </button>
            ) : event.state === "completed" && event.text ? (
              <button
                type="button"
                className="fd-focus ml-auto inline-flex shrink-0 items-center gap-2 rounded-full border border-border-default px-3 py-1.5 text-[length:var(--fd-text-xs)] font-medium text-fg-primary hover:bg-surface-3"
                onClick={copyTranscript}
              >
                {copied ? (
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied" : rewrite ? "Copy rewrite" : "Copy transcript"}
              </button>
            ) : (
              <span className="ml-auto shrink-0 font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                {event.state === "recording" ? "Esc to cancel" : ""}
              </span>
            )}
          </>
        )}
      </section>
    </main>
  );
}
