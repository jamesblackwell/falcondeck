import { memo, useState } from 'react'

import type { createDaemonApiClient, GitFileStatus } from '@falcondeck/client-core'

import { useGitStatus } from '../hooks/useGitStatus'
import { useGitDiff } from '../hooks/useGitDiff'
import { FileListView } from './diff/FileListView'
import { DiffView } from './diff/DiffView'

export type DiffPanelProps = {
  api: ReturnType<typeof createDaemonApiClient> | null
  workspaceId: string | null
  refreshTrigger: number
}

export const DiffPanel = memo(function DiffPanel({ api, workspaceId, refreshTrigger }: DiffPanelProps) {
  const [selection, setSelection] = useState<{
    workspaceId: string
    filePath: string
    status: GitFileStatus
  } | null>(null)
  const selectedFile =
    selection && selection.workspaceId === workspaceId ? selection.filePath : null
  const selectedStatus =
    selection && selection.workspaceId === workspaceId ? selection.status : null
  const { status, isLoading, error, refresh } = useGitStatus(api, workspaceId, refreshTrigger)
  const { diff, content, isLoading: isDiffLoading, error: diffError } = useGitDiff(
    api,
    workspaceId,
    selectedFile,
    selectedStatus,
  )

  if (selectedFile) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        <DiffView
          filePath={selectedFile}
          diff={diff}
          content={content}
          isLoading={isDiffLoading}
          error={diffError}
          onBack={() => setSelection(null)}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <FileListView
        entries={status?.entries ?? []}
        branch={status?.branch ?? null}
        isLoading={isLoading}
        error={error}
        onRefresh={() => void refresh()}
        onSelectFile={(entry) =>
          setSelection(workspaceId ? { workspaceId, filePath: entry.path, status: entry.status } : null)
        }
      />
    </div>
  )
})
