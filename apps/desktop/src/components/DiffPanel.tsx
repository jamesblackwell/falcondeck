import { memo, useState } from 'react'

import type { createDaemonApiClient } from '@falcondeck/client-core'

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
  } | null>(null)
  const selectedFile =
    selection && selection.workspaceId === workspaceId ? selection.filePath : null
  const { status, isLoading, error, refresh } = useGitStatus(api, workspaceId, refreshTrigger)
  const { diff, isLoading: isDiffLoading, error: diffError } = useGitDiff(api, workspaceId, selectedFile)

  if (selectedFile) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        <DiffView
          filePath={selectedFile}
          diff={diff}
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
        onSelectFile={(filePath) =>
          setSelection(workspaceId ? { workspaceId, filePath } : null)
        }
      />
    </div>
  )
})
