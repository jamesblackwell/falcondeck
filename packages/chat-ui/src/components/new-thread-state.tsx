import { memo, useState } from 'react'

import type { WorkspaceSummary } from '@falcondeck/client-core'
import { Tooltip } from '@falcondeck/ui'

export type NewThreadStateProps = {
  selectedWorkspace: WorkspaceSummary | null
  /** Opens the composer project picker — the same menu as the context-bar chip. */
  onOpenProjectPicker: () => void
}

const STARTER_MESSAGES = [
  { lead: 'What should we build in', ending: '?' },
  { lead: 'What idea should we bring to life in', ending: '?' },
  { lead: 'What could we make better in', ending: '?' },
  { lead: 'Ready to turn an idea into something real in', ending: '?' },
  { lead: 'Let’s make something remarkable in', ending: '.' },
] as const

const PROJECT_NAME_CLASS =
  'fd-focus inline cursor-pointer rounded-[var(--fd-radius-sm)] underline decoration-border-emphasis decoration-2 underline-offset-4 transition-colors hover:text-accent hover:decoration-accent'

/**
 * Centered greeting for a fresh thread. Project, isolation, and branch stay in
 * the context bar; the highlighted name here is a second trigger for that
 * same picker, not a second picker.
 */
export const NewThreadState = memo(function NewThreadState({
  selectedWorkspace,
  onOpenProjectPicker,
}: NewThreadStateProps) {
  const label = selectedWorkspace?.path.split('/').pop()
  const isCasualChat = selectedWorkspace?.kind === 'casual'
  const [starterMessage] = useState(
    () => STARTER_MESSAGES[Math.floor(Math.random() * STARTER_MESSAGES.length)]!,
  )

  return (
    <div className="flex min-h-full w-full flex-1 flex-col items-center justify-center gap-3">
      <div className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
        {isCasualChat ? (
          'What would you like to talk about?'
        ) : label ? (
          <>
            {starterMessage.lead}{' '}
            <Tooltip label="Change project">
              <button
                type="button"
                onClick={onOpenProjectPicker}
                className={PROJECT_NAME_CLASS}
              >
                {label}
              </button>
            </Tooltip>
            {starterMessage.ending}
          </>
        ) : (
          <>
            Choose a{' '}
            <Tooltip label="Choose a project">
              <button
                type="button"
                onClick={onOpenProjectPicker}
                className={PROJECT_NAME_CLASS}
              >
                project
              </button>
            </Tooltip>
            {' '}and let’s make something remarkable.
          </>
        )}
      </div>
    </div>
  )
})
