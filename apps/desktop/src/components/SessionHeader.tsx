import { RadioTower } from 'lucide-react'

import type { RemoteStatusResponse, ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'
import { Badge, StatusIndicator, Toolbar, ToolbarGroup } from '@falcondeck/ui'

import { remoteHeadline } from '../utils'

export type SessionHeaderProps = {
  workspace: WorkspaceSummary | null
  thread: ThreadSummary | null
  selectedModel: string | null
  selectedEffort: string | null
  remoteStatus: RemoteStatusResponse | null
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

export function SessionHeader({
  workspace,
  thread,
  selectedModel,
  selectedEffort,
  remoteStatus,
}: SessionHeaderProps) {
  const pathLabel = workspace?.path.split('/').pop()

  return (
    <Toolbar data-tauri-drag-region className="rounded-t-[var(--fd-radius-xl)] bg-surface-1">
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
        {selectedModel ? (
          <Badge>
            {workspace?.models.find((m) => m.id === selectedModel)?.label ?? selectedModel}
          </Badge>
        ) : null}
        {selectedEffort ? <Badge>{selectedEffort}</Badge> : null}
        <div className="flex items-center gap-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
          <RadioTower className="h-3.5 w-3.5" />
          <span className={remoteStatus?.status === 'connected' ? 'text-success' : undefined}>
            {remoteHeadline(remoteStatus?.status)}
          </span>
        </div>
      </ToolbarGroup>
    </Toolbar>
  )
}
