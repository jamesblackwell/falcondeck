import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '@falcondeck/ui'

import type {
  GitDiffResponse,
  GitFileStatus,
  GitStatusEntry,
  GitStatusResponse,
  StartReviewPayload,
  WorkspaceFileResponse,
  WorkspaceFilesResponse,
  WriteWorkspaceFilePayload,
} from '@falcondeck/client-core'

import { useGitStatus } from '../hooks/useGitStatus'
import { useGitDiff } from '../hooks/useGitDiff'
import { useWorkspaceFile } from '../hooks/useWorkspaceFile'
import { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'
import { DiffView } from './diff/DiffView'
import { FileListView, type ReviewPanelTab } from './diff/FileListView'
import { FileView } from './diff/FileView'
import type { ReviewInfoContext } from './diff/InfoView'

const EMPTY_ENTRIES: GitStatusEntry[] = []
const EMPTY_FILES: string[] = []

type ReviewApi = {
  gitStatus: (workspaceId: string, threadId?: string | null) => Promise<GitStatusResponse>
  gitDiff: (
    workspaceId: string,
    path?: string,
    status?: GitFileStatus | null,
    threadId?: string | null,
  ) => Promise<GitDiffResponse>
  workspaceFiles: (workspaceId: string, threadId?: string | null) => Promise<WorkspaceFilesResponse>
  workspaceFile: (
    workspaceId: string,
    path: string,
    threadId?: string | null,
  ) => Promise<WorkspaceFileResponse>
  writeWorkspaceFile: (
    workspaceId: string,
    path: string,
    payload: WriteWorkspaceFilePayload,
    threadId?: string | null,
  ) => Promise<WorkspaceFileResponse>
  startReview?: (payload: StartReviewPayload) => Promise<unknown>
}

/** The file the panel is showing, scoped to its workspace and review surface. */
export type DiffPanelSelection = {
  workspaceId: string
  filePath: string
  view?: ReviewPanelTab
  /** 1-based line the file viewer scrolls to and highlights. */
  line?: number | null
}

export type DiffPanelProps = {
  api: ReviewApi | null
  workspaceId: string | null
  threadId?: string | null
  refreshTrigger: number
  reviewThreadId?: string | null
  selection: DiffPanelSelection | null
  onSelectionChange: (selection: DiffPanelSelection | null) => void
  /** Where the work happens, for the overview tab. Null hides that tab. */
  info?: ReviewInfoContext | null
}

export const DiffPanel = memo(function DiffPanel({
  api,
  workspaceId,
  threadId = null,
  refreshTrigger,
  reviewThreadId = null,
  selection,
  onSelectionChange,
  info = null,
}: DiffPanelProps) {
  const { toast } = useToast()
  // The overview opens first: it frames what the changes list is a list *of*.
  const [activeTab, setActiveTab] = useState<ReviewPanelTab>('info')
  const [isReviewPending, setIsReviewPending] = useState(false)
  const previewContextRef = useRef({ workspaceId, threadId })
  const selectedFile =
    selection && selection.workspaceId === workspaceId ? selection.filePath : null
  const selectedView = selection?.view ?? 'changes'
  const gitEnabled = info?.workspaceKind !== 'casual'

  useEffect(() => {
    const previous = previewContextRef.current
    previewContextRef.current = { workspaceId, threadId }
    if (
      selection &&
      (previous.workspaceId !== workspaceId || previous.threadId !== threadId)
    ) {
      onSelectionChange(null)
    }
  }, [onSelectionChange, selection, threadId, workspaceId])

  const {
    status,
    isLoading,
    error,
    refresh: refreshStatus,
  } = useGitStatus(gitEnabled ? api : null, workspaceId, refreshTrigger, threadId)
  const statusByPath = useMemo(
    () => new Map((status?.entries ?? []).map((entry) => [entry.path, entry])),
    [status?.entries],
  )
  const selectedStatus = selectedFile
    ? statusByPath.get(selectedFile)?.status ?? 'modified'
    : null
  const { diff, content, isLoading: isDiffLoading, error: diffError } = useGitDiff(
    selectedView === 'changes' && gitEnabled ? api : null,
    workspaceId,
    selectedFile,
    selectedStatus,
    threadId,
  )
  const {
    result: workspaceFiles,
    isLoading: isFilesLoading,
    error: filesError,
    refresh: refreshFiles,
  } = useWorkspaceFiles(
    api,
    workspaceId,
    threadId,
    activeTab === 'files' || (selectedFile != null && selectedView === 'files'),
  )
  const {
    file,
    isLoading: isFileLoading,
    isSaving,
    error: fileError,
    reload: reloadFile,
    save: saveFile,
  } = useWorkspaceFile(
    selectedView === 'files' ? api : null,
    workspaceId,
    threadId,
    selectedFile,
  )

  useEffect(() => {
    if (selectedFile) setActiveTab(selectedView)
  }, [selectedFile, selectedView])

  const selectFile = useCallback(
    (filePath: string, view: ReviewPanelTab) =>
      onSelectionChange(workspaceId ? { workspaceId, filePath, view } : null),
    [onSelectionChange, workspaceId],
  )

  const selectChangedFile = useCallback(
    (entry: GitStatusEntry) => selectFile(entry.path, 'changes'),
    [selectFile],
  )

  const selectWorkspaceFile = useCallback(
    (path: string) => selectFile(path, 'files'),
    [selectFile],
  )

  const refreshChanges = useCallback(() => void refreshStatus(), [refreshStatus])

  const refreshWorkspaceFiles = useCallback(() => void refreshFiles(), [refreshFiles])

  const startReview = useCallback(() => {
    if (!api?.startReview || !workspaceId || !reviewThreadId) return
    setIsReviewPending(true)
    void api
      .startReview?.({
        workspace_id: workspaceId,
        thread_id: reviewThreadId,
        target: { type: 'uncommittedChanges' },
      })
      .then(() =>
        toast({
          variant: 'default',
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
  }, [api, reviewThreadId, toast, workspaceId])

  const adjacentSelection = useCallback(
    (direction: -1 | 1) => {
      if (!selectedFile || !status?.entries.length) return
      const currentIndex = status.entries.findIndex((entry) => entry.path === selectedFile)
      const nextIndex = (currentIndex + direction + status.entries.length) % status.entries.length
      const next = status.entries[nextIndex]
      if (next) selectFile(next.path, 'changes')
    },
    [selectFile, selectedFile, status?.entries],
  )

  if (selectedFile && selectedView === 'files') {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        <FileView
          key={`${workspaceId}:${selectedFile}`}
          filePath={selectedFile}
          line={selection?.line ?? null}
          file={file}
          isLoading={isFileLoading}
          isSaving={isSaving}
          error={fileError}
          onBack={() => onSelectionChange(null)}
          onReload={() => void reloadFile()}
          onSave={async (nextContent) => {
            const saved = await saveFile(nextContent)
            if (saved) {
              void refreshStatus()
              toast({ variant: 'success', title: 'File saved', description: selectedFile })
            }
            return saved
          }}
        />
      </div>
    )
  }

  if (selectedFile) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        <DiffView
          filePath={selectedFile}
          diff={diff}
          content={content}
          isLoading={isDiffLoading}
          error={diffError}
          onBack={() => onSelectionChange(null)}
          onOpenFile={selectedStatus === 'deleted' ? null : () => selectFile(selectedFile, 'files')}
          onPrevious={() => adjacentSelection(-1)}
          onNext={() => adjacentSelection(1)}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <FileListView
        entries={status?.entries ?? EMPTY_ENTRIES}
        files={workspaceFiles?.files ?? EMPTY_FILES}
        filesTruncated={workspaceFiles?.truncated ?? false}
        branch={status?.branch ?? null}
        activeTab={activeTab}
        isLoading={isLoading}
        isFilesLoading={isFilesLoading}
        error={error}
        filesError={filesError}
        onTabChange={setActiveTab}
        onRefresh={refreshChanges}
        onRefreshFiles={refreshWorkspaceFiles}
        isReviewPending={isReviewPending}
        onStartReview={api?.startReview && workspaceId && reviewThreadId ? startReview : null}
        onSelectChangedFile={selectChangedFile}
        onSelectWorkspaceFile={selectWorkspaceFile}
        info={info}
        showChanges={gitEnabled}
      />
    </div>
  )
})
