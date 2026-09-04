import { memo } from 'react'
import * as React from 'react'
import { Split, SquarePen } from 'lucide-react'

import type { ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'
import { ActivityDiamond, Badge, Button, StatusIndicator, Toolbar, ToolbarGroup, cn } from '@falcondeck/ui'

import { ProviderIcon } from './provider-icon'

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
  /**
   * Rendered at the head of the trailing group, before New and the embedding
   * app's own controls. The isolated-thread Merge control lives here.
   */
  leadingActions?: React.ReactNode
  children?: React.ReactNode
  className?: string
}

export const SessionHeader = memo(function SessionHeader({
  workspace,
  thread,
  compact = false,
  navigation,
  onNewThread,
  leadingActions,
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
          ) : (thread.attention.background_task_count ?? 0) > 0 ? (
            // The turn is over, but work it started is still live and will
            // wake the thread. An idle dot here reads as "nothing is
            // happening", which is how a thread appears to restart itself.
            <span
              role="img"
              aria-label="Background work still running"
              title="Background work still running"
              className="flex items-center justify-center"
            >
              <ActivityDiamond size="md" variant="outline" />
            </span>
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
                <ProviderIcon provider={thread.provider} className="h-3 w-3" />
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
        {leadingActions}
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
