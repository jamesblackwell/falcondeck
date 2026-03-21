import { memo } from 'react'
import { ChevronDown } from 'lucide-react'

import type { WorkspaceSummary } from '@falcondeck/client-core'

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
    <div className="flex min-h-full w-full flex-1 flex-col items-center justify-center gap-4">
      <p className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
        Let&apos;s build
      </p>
      {workspaces.length > 1 ? (
        <div className="relative">
          <select
            value={selectedWorkspace?.id ?? ''}
            onChange={(e) => onSelectWorkspace(e.target.value)}
            className="appearance-none rounded-[var(--fd-radius-md)] bg-transparent py-1 pl-2 pr-9 text-[length:var(--fd-text-2xl)] font-medium text-fg-muted transition-colors hover:text-fg-secondary focus:outline-none"
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.path.split('/').pop()}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-5 w-5 -translate-y-1/2 text-fg-faint" />
        </div>
      ) : (
        <p className="text-[length:var(--fd-text-2xl)] font-medium text-fg-muted">{label}</p>
      )}
    </div>
  )
})
