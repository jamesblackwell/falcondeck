import { memo, useState } from 'react'

import type { WorkspaceSummary } from '@falcondeck/client-core'

export type NewThreadStateProps = {
  selectedWorkspace: WorkspaceSummary | null
}

const STARTER_MESSAGES = [
  { lead: 'What should we build in', ending: '?' },
  { lead: 'What idea should we bring to life in', ending: '?' },
  { lead: 'What could we make better in', ending: '?' },
  { lead: 'Ready to turn an idea into something real in', ending: '?' },
  { lead: 'Let’s make something remarkable in', ending: '.' },
] as const

/**
 * Centered greeting for a fresh thread. Project, isolation, and branch are
 * chosen in the context bar docked above the composer, so this only names the
 * target project instead of duplicating the picker.
 */
export const NewThreadState = memo(function NewThreadState({
  selectedWorkspace,
}: NewThreadStateProps) {
  const label = selectedWorkspace?.path.split('/').pop()
  const [starterMessage] = useState(
    () => STARTER_MESSAGES[Math.floor(Math.random() * STARTER_MESSAGES.length)]!,
  )

  return (
    <div className="flex min-h-full w-full flex-1 flex-col items-center justify-center gap-3">
      <p className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
        {label ? (
          <>
            {starterMessage.lead}{' '}
            <span className="underline decoration-border-emphasis decoration-2 underline-offset-4">
              {label}
            </span>
            {starterMessage.ending}
          </>
        ) : (
          'Choose a project and let’s make something remarkable.'
        )}
      </p>
    </div>
  )
})
