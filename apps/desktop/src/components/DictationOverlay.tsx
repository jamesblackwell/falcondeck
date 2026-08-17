import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Check, Mic, RotateCcw, Trash2, X } from "lucide-react";

type DictationState =
  | "recording"
  | "transcribing"
  | "completed"
  | "failed"
  | "cancelled";

type DictationEvent = {
  state: DictationState;
  text?: string;
  error?: string;
  retainedAudio: boolean;
};

const INITIAL_EVENT: DictationEvent = {
  state: "recording",
  retainedAudio: false,
};

function Waveform() {
  return (
    <span className="flex h-6 items-center gap-1" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6].map((bar) => (
        <span
          key={bar}
          className="fd-dictation-wave h-2 w-1 rounded-full bg-accent"
          style={{ animationDelay: `${bar * 90}ms` }}
        />
      ))}
    </span>
  );
}

export function DictationOverlay() {
  const [event, setEvent] = useState<DictationEvent>(INITIAL_EVENT);

  useEffect(() => {
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
  }, []);

  const failed = event.state === "failed";
  const label =
    event.state === "recording"
      ? "Listening"
      : event.state === "transcribing"
        ? "Transcribing"
        : event.state === "completed"
          ? "Pasted"
          : event.state === "cancelled"
            ? "Cancelled"
            : "Dictation needs attention";

  return (
    <main className="flex h-full w-full items-start justify-center p-2">
      <section
        className={
          failed
            ? "w-full rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1/95 px-4 py-3 shadow-[var(--fd-shadow-lg)] backdrop-blur-xl"
            : "flex h-14 min-w-72 items-center gap-3 rounded-full border border-border-default bg-surface-1/95 px-4 shadow-[var(--fd-shadow-lg)] backdrop-blur-xl"
        }
        role="status"
        aria-live="polite"
      >
        {failed ? (
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-full bg-danger-muted p-1.5 text-danger">
              <X aria-hidden="true" className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                {label}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[length:var(--fd-text-xs)] text-fg-muted">
                {event.error}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              {event.retainedAudio ? (
                <button
                  type="button"
                  className="fd-focus rounded-[var(--fd-radius-md)] p-2 text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
                  aria-label="Retry transcription"
                  onClick={() => void invoke("retry_dictation")}
                >
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                </button>
              ) : null}
              <button
                type="button"
                className="fd-focus rounded-[var(--fd-radius-md)] p-2 text-fg-secondary hover:bg-surface-3 hover:text-danger"
                aria-label={event.retainedAudio ? "Discard recording" : "Dismiss"}
                onClick={() => void invoke("discard_dictation")}
              >
                {event.retainedAudio ? (
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                ) : (
                  <X aria-hidden="true" className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
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
            {event.state === "recording" ? <Waveform /> : null}
            <span className="ml-auto font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
              {event.state === "recording" ? "Esc to cancel" : ""}
            </span>
          </>
        )}
      </section>
    </main>
  );
}
