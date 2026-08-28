import { ActivityDiamond } from "@falcondeck/ui";

/** Blocks stale sidebar/thread interaction until persisted summaries are complete. */
export function StartupRestoreOverlay() {
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] px-6 backdrop-blur-sm">
      <div
        role="status"
        aria-live="polite"
        aria-label="Restoring FalconDeck sessions"
        className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 px-5 py-4 shadow-[var(--fd-shadow-lg)]"
      >
        <ActivityDiamond size="md" />
        <div>
          <p className="text-[length:var(--fd-text-base)] font-medium text-fg-primary">
            Restoring your sessions
          </p>
          <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
            Checking for work that stopped when FalconDeck closed…
          </p>
        </div>
      </div>
    </div>
  );
}
