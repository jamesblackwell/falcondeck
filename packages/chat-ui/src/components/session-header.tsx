import { memo } from 'react'
import * as React from 'react'

import type { ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'
import { Badge, StatusIndicator, Toolbar, ToolbarGroup, cn } from '@falcondeck/ui'

function threadStatusDisplay(status: ThreadSummary['status']) {
  switch (status) {
    case 'running':
      return 'active' as const
    case 'waiting_for_input':
      return 'warning' as const
    case 'error':
      return 'error' as const
    default:
      return 'idle' as const
  }
}

export type SessionHeaderProps = {
  workspace: WorkspaceSummary | null
  thread: ThreadSummary | null
  navigation?: React.ReactNode
  children?: React.ReactNode
  className?: string
}

export const SessionHeader = memo(function SessionHeader({
  workspace,
  thread,
  navigation,
  children,
  className,
}: SessionHeaderProps) {
  const pathLabel = workspace?.path.split('/').pop()

  return (
    <Toolbar className={cn('bg-surface-1 pt-10', className)}>
      <div className="flex min-w-0 items-center gap-3">
        {navigation}
        {thread ? (
          <StatusIndicator
            status={threadStatusDisplay(thread.status)}
            size="md"
            pulse={thread.status === 'running'}
          />
        ) : null}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[length:var(--fd-text-2xs)] uppercase tracking-[0.12em] text-fg-muted">
              {pathLabel ?? 'No project'}
            </p>
            {thread ? (
              <Badge variant="default" className="h-5 px-1.5 text-[10px] uppercase tracking-[0.08em]">
                {thread.provider}
              </Badge>
            ) : null}
          </div>
          {thread ? (
            <p className="truncate text-[length:var(--fd-text-md)] font-semibold text-fg-primary">
              {thread.title}
            </p>
          ) : null}
        </div>
      </div>

      <ToolbarGroup align="end">{children}</ToolbarGroup>
    </Toolbar>
  )
})
