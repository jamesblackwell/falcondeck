import { memo } from 'react'

import type { WorkspaceSummary } from '@falcondeck/client-core'

export type NewThreadStateProps = {
  selectedWorkspace: WorkspaceSummary | null
}

/**
 * Centered greeting for a fresh thread. Project, isolation, and branch are
 * chosen in the context bar docked above the composer, so this only names the
 * target project instead of duplicating the picker.
 */
export const NewThreadState = memo(function NewThreadState({
  selectedWorkspace,
}: NewThreadStateProps) {
  const label = selectedWorkspace?.path.split('/').pop()

  return (
    <div className="flex min-h-full w-full flex-1 flex-col items-center justify-center gap-3">
      <p className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
        {label ? (
          <>
            What should we build in{' '}
            <span className="underline decoration-border-emphasis decoration-2 underline-offset-4">
              {label}
            </span>
            ?
          </>
        ) : (
          'Select a project to get started'
        )}
      </p>
    </div>
  )
})
