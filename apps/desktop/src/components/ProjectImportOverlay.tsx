import { useEffect, useState } from 'react'

import { ActivityDiamond } from '@falcondeck/ui'

export const PROJECT_IMPORT_OVERLAY_DELAY_MS = 250
export const PROJECT_IMPORT_OVERLAY_MAX_VISIBLE_MS = 2_000

export function ProjectImportOverlay() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const showTimer = window.setTimeout(
      () => setVisible(true),
      PROJECT_IMPORT_OVERLAY_DELAY_MS,
    )
    const hideTimer = window.setTimeout(
      () => setVisible(false),
      PROJECT_IMPORT_OVERLAY_DELAY_MS + PROJECT_IMPORT_OVERLAY_MAX_VISIBLE_MS,
    )
    return () => {
      window.clearTimeout(showTimer)
      window.clearTimeout(hideTimer)
    }
  }, [])

  if (!visible) return null

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] px-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-6 shadow-[var(--fd-shadow-lg)]">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-surface-3 p-2 text-accent">
            <ActivityDiamond size="lg" tone="current" />
          </div>
          <div className="space-y-1">
            <h2 className="text-[length:var(--fd-text-lg)] font-medium text-fg-primary">
              Importing existing agent sessions
            </h2>
            <p className="text-[length:var(--fd-text-sm)] text-fg-muted">This might take a moment.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
