import { memo } from 'react'
import * as React from 'react'
import { SquarePen } from 'lucide-react'

import type { ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'
import { Badge, Button, StatusIndicator, Toolbar, ToolbarGroup, cn } from '@falcondeck/ui'

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
  onNewThread?: () => void
  children?: React.ReactNode
  className?: string
}

export const SessionHeader = memo(function SessionHeader({
  workspace,
  thread,
  navigation,
  onNewThread,
  children,
  className,
}: SessionHeaderProps) {
  const pathLabel = workspace?.path.split('/').pop()

  return (
    <Toolbar className={cn('bg-surface-1 pt-8', className)}>
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
              <Badge
                variant="default"
                className="h-5 px-1.5 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em]"
              >
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

      <ToolbarGroup align="end">
        {thread && onNewThread ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onNewThread}
            aria-label="New thread with current settings"
            title="New thread with current settings"
          >
            <SquarePen aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">New</span>
          </Button>
        ) : null}
        {children}
      </ToolbarGroup>
    </Toolbar>
  )
})
