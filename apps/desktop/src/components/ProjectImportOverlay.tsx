import { LoaderCircle } from 'lucide-react'

export function ProjectImportOverlay() {
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-6 shadow-[var(--fd-shadow-lg)]">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-surface-3 p-2 text-accent">
            <LoaderCircle className="h-5 w-5 animate-spin" />
          </div>
          <div className="space-y-1">
            <h2 className="text-[length:var(--fd-text-lg)] font-medium text-fg-primary">
              Importing existing Claude and Codex sessions
            </h2>
            <p className="text-[length:var(--fd-text-sm)] text-fg-muted">This might take a moment.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
