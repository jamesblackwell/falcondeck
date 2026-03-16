import { memo } from 'react'
import { FolderOpen } from 'lucide-react'

import type { WorkspaceSummary } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

export type WorkspaceGroupProps = {
  workspace: WorkspaceSummary
  isSelected: boolean
  onSelect: () => void
  children: React.ReactNode
}

export const WorkspaceGroup = memo(function WorkspaceGroup({ workspace, isSelected, onSelect, children }: WorkspaceGroupProps) {
  const pathLabel = workspace.path.split('/').pop() ?? workspace.path

  return (
    <section>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left transition-colors duration-[var(--fd-duration-fast)]',
          isSelected
            ? 'text-fg-primary'
            : 'text-fg-secondary hover:text-fg-primary',
        )}
        onClick={onSelect}
      >
        <FolderOpen className="h-4 w-4 shrink-0 text-fg-muted" />
        <span className="truncate text-[length:var(--fd-text-sm)] font-medium">{pathLabel}</span>
      </button>
      <div className="pl-2">
        {children}
      </div>
    </section>
  )
})
