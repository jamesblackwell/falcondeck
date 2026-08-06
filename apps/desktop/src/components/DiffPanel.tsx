import { memo, useState } from 'react'
import { useToast } from '@falcondeck/ui'

import type { createDaemonApiClient, GitFileStatus } from '@falcondeck/client-core'

import { useGitStatus } from '../hooks/useGitStatus'
import { useGitDiff } from '../hooks/useGitDiff'
import { FileListView } from './diff/FileListView'
import { DiffView } from './diff/DiffView'

export type DiffPanelProps = {
  api: ReturnType<typeof createDaemonApiClient> | null
  workspaceId: string | null
  refreshTrigger: number
  /** Codex thread eligible to run a review over the working tree, if any. */
  reviewThreadId?: string | null
}

export const DiffPanel = memo(function DiffPanel({
  api,
  workspaceId,
  refreshTrigger,
  reviewThreadId = null,
}: DiffPanelProps) {
  const { toast } = useToast()
  const [isReviewPending, setIsReviewPending] = useState(false)
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
        isReviewPending={isReviewPending}
        onStartReview={
          api && workspaceId && reviewThreadId
            ? () => {
                setIsReviewPending(true)
                void api
                  .startReview({
                    workspace_id: workspaceId,
                    thread_id: reviewThreadId,
                    target: { type: 'uncommittedChanges' },
                  })
                  .then(() =>
                    toast({
                      title: 'Review started',
                      description: 'Codex is reviewing the uncommitted changes in this thread.',
                    }),
                  )
                  .catch((error: unknown) =>
                    toast({
                      variant: 'danger',
                      title: 'Failed to start review',
                      description: error instanceof Error ? error.message : undefined,
                    }),
                  )
                  .finally(() => setIsReviewPending(false))
              }
            : null
        }
        onSelectFile={(entry) =>
          setSelection(workspaceId ? { workspaceId, filePath: entry.path, status: entry.status } : null)
        }
      />
    </div>
  )
})
