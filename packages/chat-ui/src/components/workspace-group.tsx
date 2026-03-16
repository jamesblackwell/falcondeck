import { ChevronRight } from 'lucide-react'

import type { WorkspaceSummary } from '@falcondeck/client-core'
import { cn, StatusIndicator } from '@falcondeck/ui'

export type WorkspaceGroupProps = {
  workspace: WorkspaceSummary
  isSelected: boolean
  onSelect: () => void
  children: React.ReactNode
}

function workspaceStatusMap(status: WorkspaceSummary['status']) {
  switch (status) {
    case 'ready':
      return 'connected' as const
    case 'connecting':
      return 'active' as const
    case 'busy':
      return 'active' as const
    case 'needs_auth':
    case 'error':
      return 'error' as const
    case 'disconnected':
      return 'disconnected' as const
    default:
      return 'idle' as const
  }
}

export function WorkspaceGroup({ workspace, isSelected, onSelect, children }: WorkspaceGroupProps) {
  const pathLabel = workspace.path.split('/').pop() ?? workspace.path

  return (
    <section className="space-y-1">
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2.5 rounded-[var(--fd-radius-lg)] px-3 py-2 text-left transition-colors duration-[var(--fd-duration-fast)]',
          isSelected
            ? 'bg-accent-dim text-fg-primary'
            : 'text-fg-secondary hover:bg-surface-3',
        )}
        onClick={onSelect}
      >
        <StatusIndicator
          status={workspaceStatusMap(workspace.status)}
          size="sm"
          pulse={workspace.status === 'connecting'}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--fd-text-sm)] font-medium">{pathLabel}</p>
          <p className="truncate text-[length:var(--fd-text-2xs)] text-fg-muted">{workspace.path}</p>
        </div>
        <ChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
      </button>
      <div className="ml-3 space-y-0.5 border-l border-border-subtle pl-2">
        {children}
      </div>
    </section>
  )
}
