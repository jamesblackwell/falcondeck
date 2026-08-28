import { useEffect, useRef } from "react";
import { CircleStop } from "lucide-react";

import type { ThreadSummary } from "@falcondeck/client-core";
import { Button } from "@falcondeck/ui";

const VISIBLE_THREAD_LIMIT = 5;

export function ResumeStoppedThreadsDialog({
  threads,
  onContinueAll,
  onDismiss,
  isPreparing = false,
  isContinuing = false,
}: {
  threads: readonly ThreadSummary[];
  onContinueAll: () => void;
  onDismiss: () => void;
  isPreparing?: boolean;
  isContinuing?: boolean;
}) {
  const continueRef = useRef<HTMLButtonElement | null>(null);
  const dismissRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    (isPreparing ? dismissRef.current : continueRef.current)?.focus();
  }, [isPreparing]);

  if (threads.length === 0) return null;

  const count = threads.length;
  const visible = threads.slice(0, VISIBLE_THREAD_LIMIT);
  const hidden = count - visible.length;

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] px-6 backdrop-blur-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onDismiss();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-stopped-threads-title"
        className="w-full max-w-md rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-6 shadow-[var(--fd-shadow-lg)]"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-danger-muted p-2 text-danger">
            <CircleStop aria-hidden="true" className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <h2
              id="resume-stopped-threads-title"
              className="text-[length:var(--fd-text-lg)] font-medium text-fg-primary"
            >
              {count === 1
                ? "1 session was stopped when FalconDeck closed"
                : `${count} sessions were stopped when FalconDeck closed`}
            </h2>
            <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
              {count === 1
                ? "Continue it from where the agent left off?"
                : "Continue them all from where the agents left off?"}
            </p>
          </div>
        </div>
        <ul className="mt-4 space-y-1 rounded-[var(--fd-radius-md)] bg-surface-2 px-3 py-2">
          {visible.map((thread) => (
            <li
              key={`${thread.workspace_id}:${thread.id}`}
              className="truncate text-[length:var(--fd-text-sm)] text-fg-secondary"
            >
              {thread.title}
            </li>
          ))}
          {hidden > 0 ? (
            <li className="fd-type-supporting text-fg-muted">
              and {hidden} more
            </li>
          ) : null}
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            ref={dismissRef}
            type="button"
            variant="ghost"
            onClick={onDismiss}
            disabled={isContinuing}
          >
            Not now
          </Button>
          <Button
            ref={continueRef}
            type="button"
            onClick={onContinueAll}
            disabled={isPreparing || isContinuing}
          >
            {isPreparing
              ? "Reconnecting…"
              : isContinuing
              ? "Continuing…"
              : count === 1
                ? "Continue"
                : "Continue all"}
          </Button>
        </div>
      </div>
    </div>
  );
}
