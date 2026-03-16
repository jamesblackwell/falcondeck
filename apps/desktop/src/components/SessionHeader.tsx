import { memo } from 'react'
import * as React from 'react'

import type { ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'
import { StatusIndicator, Toolbar, ToolbarGroup } from '@falcondeck/ui'

export type SessionHeaderProps = {
  workspace: WorkspaceSummary | null
  thread: ThreadSummary | null
  children?: React.ReactNode
}

function threadStatusDisplay(status: ThreadSummary['status']) {
  switch (status) {
    case 'running':
      return 'active' as const
    case 'waiting_for_approval':
      return 'warning' as const
    case 'error':
      return 'error' as const
    default:
      return 'idle' as const
  }
}

export const SessionHeader = memo(function SessionHeader({
  workspace,
  thread,
  children,
}: SessionHeaderProps) {
  const pathLabel = workspace?.path.split('/').pop()

  return (
    <Toolbar className="bg-surface-1 pt-10">
      <div className="flex items-center gap-3">
        {thread ? (
          <StatusIndicator
            status={threadStatusDisplay(thread.status)}
            size="md"
            pulse={thread.status === 'running'}
          />
        ) : null}
        <div>
          <p className="text-[length:var(--fd-text-2xs)] uppercase tracking-[0.12em] text-fg-muted">
            {pathLabel ?? 'No project'}
          </p>
          <p className="text-[length:var(--fd-text-md)] font-semibold text-fg-primary">
            {thread?.title ?? 'Select a thread'}
          </p>
        </div>
      </div>

      <ToolbarGroup align="end">
        {children}
      </ToolbarGroup>
    </Toolbar>
  )
})
