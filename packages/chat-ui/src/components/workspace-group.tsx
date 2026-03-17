import { memo } from 'react'
import { FolderOpen, SquarePen } from 'lucide-react'

import type { WorkspaceSummary } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

export type WorkspaceGroupProps = {
  workspace: WorkspaceSummary
  isSelected: boolean
  onSelect: () => void
  onNewThread?: () => void
  children: React.ReactNode
}

export const WorkspaceGroup = memo(function WorkspaceGroup({ workspace, isSelected, onSelect, onNewThread, children }: WorkspaceGroupProps) {
  const pathLabel = workspace.path.split('/').pop() ?? workspace.path

  return (
    <section className="min-w-0 overflow-hidden">
      <div
        className={cn(
          'group flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 transition-colors duration-[var(--fd-duration-fast)]',
          isSelected
            ? 'text-fg-primary'
            : 'text-fg-secondary hover:text-fg-primary',
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={onSelect}
        >
          <FolderOpen className="h-4 w-4 shrink-0 text-fg-muted" />
          <span className="truncate text-[length:var(--fd-text-sm)] font-medium">{pathLabel}</span>
        </button>
        {onNewThread ? (
          <button
            type="button"
            onClick={onNewThread}
            title={`Start new thread in ${pathLabel}`}
            className="shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary"
          >
            <SquarePen className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="min-w-0 pl-2">
        {children}
      </div>
    </section>
  )
})
