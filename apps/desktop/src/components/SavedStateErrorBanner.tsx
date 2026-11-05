export function SavedStateErrorBanner({
  title = "FalconDeck couldn't load your saved data",
  error,
}: {
  title?: string;
  error: string;
}) {
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-3 z-[60] mx-auto w-full max-w-xl rounded-[var(--fd-radius-lg)] border border-danger/30 bg-surface-2 px-4 py-3 shadow-[var(--fd-shadow-lg)]"
    >
      <p className="text-[length:var(--fd-text-base)] font-medium text-danger">
        {title}
      </p>
      <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-secondary">
        FalconDeck won't overwrite it while this message is showing. Fix or
        restore any file named below, then restart FalconDeck.
      </p>
      <p className="mt-2 break-words font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
        {error}
      </p>
    </div>
  );
}
