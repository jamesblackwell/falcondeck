import { memo } from 'react'
import * as React from 'react'
import { Split, SquarePen } from 'lucide-react'

import type { ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'
import { ActivityDiamond, Badge, Button, StatusIndicator, Toolbar, ToolbarGroup, cn } from '@falcondeck/ui'

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
  compact?: boolean
  navigation?: React.ReactNode
  onNewThread?: () => void
  children?: React.ReactNode
  className?: string
}

export const SessionHeader = memo(function SessionHeader({
  workspace,
  thread,
  compact = false,
  navigation,
  onNewThread,
  children,
  className,
}: SessionHeaderProps) {
  const pathLabel = workspace?.path.split('/').pop()

  return (
    <Toolbar
      // Drags the window on desktop; Tauri exempts buttons and other clickable
      // descendants, so the header controls keep working.
      data-tauri-drag-region="deep"
      className={cn(
        'bg-surface-1 pt-8',
        compact && 'h-12 py-0 pt-0',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {navigation}
        {thread ? (
          thread.status === 'running' ? (
            <ActivityDiamond size="md" />
          ) : (
            <StatusIndicator status={threadStatusDisplay(thread.status)} size="md" />
          )
        ) : null}
        <div className={cn('min-w-0', compact && 'flex items-center gap-2')}>
          <div className={cn('flex items-center gap-2', compact && 'contents')}>
            <p
              className={cn(
                'truncate text-[length:var(--fd-text-2xs)] uppercase tracking-[0.12em] text-fg-muted',
                compact &&
                  thread &&
                  'text-[length:var(--fd-text-base)] font-semibold normal-case tracking-normal text-fg-primary',
              )}
            >
              {compact && thread ? thread.title : (pathLabel ?? 'No project')}
            </p>
            {thread ? (
              <Badge
                variant="default"
                className="h-5 px-1.5 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em]"
              >
                {thread.provider}
              </Badge>
            ) : null}
            {thread?.variant ? (
              <Badge
                variant="default"
                title={`Changes land on branch ${thread.variant.branch}, not in your project folder`}
                className="h-5 gap-1 px-1.5 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em]"
              >
                <Split aria-hidden="true" className="h-3 w-3" />
                Isolated
              </Badge>
            ) : null}
          </div>
          {thread && !compact ? (
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
