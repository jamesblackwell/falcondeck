import { memo } from 'react'
import { FolderClosed } from 'lucide-react'

import type { WorkspaceSummary } from '@falcondeck/client-core'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@falcondeck/ui'

export type NewThreadStateProps = {
  workspaces: WorkspaceSummary[]
  selectedWorkspace: WorkspaceSummary | null
  onSelectWorkspace: (workspaceId: string) => void
}

export const NewThreadState = memo(function NewThreadState({
  workspaces,
  selectedWorkspace,
  onSelectWorkspace,
}: NewThreadStateProps) {
  const label = selectedWorkspace?.path.split('/').pop() ?? 'Select a project'

  return (
    <div className="flex min-h-full w-full flex-1 flex-col items-center justify-center gap-3">
      <p className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
        Let&apos;s build
      </p>
      {workspaces.length > 1 ? (
        <Select value={selectedWorkspace?.id ?? undefined} onValueChange={onSelectWorkspace}>
          <SelectTrigger
            aria-label="Project"
            className="h-9 w-fit gap-2 px-3 text-[length:var(--fd-text-sm)]"
          >
            <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
            <SelectValue placeholder="Select a project" />
          </SelectTrigger>
          <SelectContent align="center">
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.path.split('/').pop()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="flex items-center gap-2 text-[length:var(--fd-text-md)] font-medium text-fg-muted">
          <FolderClosed aria-hidden="true" className="h-4 w-4" />
          {label}
        </p>
      )}
    </div>
  )
})
