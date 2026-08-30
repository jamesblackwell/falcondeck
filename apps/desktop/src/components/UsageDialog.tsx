import { useEffect, useRef } from 'react'
import { Gauge, X } from 'lucide-react'

import { Button } from '@falcondeck/ui'
import { UsagePanel, type UsagePanelProps } from './settings/UsagePanel'

export type UsageDialogProps = {
  open: boolean
  onClose: () => void
  baseUrl: string | null
  onToast: UsagePanelProps['onToast']
}

export function UsageDialog({
  open,
  onClose,
  baseUrl,
  onToast,
}: UsageDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (open) {
      closeButtonRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      role="presentation"
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] p-4 backdrop-blur-sm sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-dialog-title"
        className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-lg)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle p-5 sm:p-6 pb-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-primary">
              <Gauge aria-hidden="true" className="h-4 w-4" />
            </div>
            <div>
              <h2
                id="usage-dialog-title"
                className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary"
              >
                Usage
              </h2>
              <p className="mt-0.5 text-[length:var(--fd-text-xs)] text-fg-muted sm:text-[length:var(--fd-text-sm)]">
                How much of your Codex, Claude Code, Grok, and Cursor subscriptions you&apos;ve
                used on this Mac.
              </p>
            </div>
          </div>
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close usage dialog"
            className="h-8 w-8 shrink-0 text-fg-muted hover:text-fg-primary"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6 pt-4">
          <UsagePanel baseUrl={baseUrl} onToast={onToast} hideHeader={true} />
        </div>
      </div>
    </div>
  )
}
