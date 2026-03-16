import { memo } from 'react'
import {
  FilePlus,
  FileMinus,
  FileEdit,
  FileDiff,
  FileQuestion,
  GitBranch,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'

import type { GitFileStatus, GitStatusEntry } from '@falcondeck/client-core'

import { dirPart, basePart, statusVariant } from './diff-utils'

function StatusIcon({ status }: { status: GitFileStatus }) {
  const v = statusVariant(status)
  const cls = `h-3.5 w-3.5 text-${v === 'muted' ? 'fg-muted' : v}`
  switch (status) {
    case 'added':
    case 'untracked':
      return <FilePlus className={cls} />
    case 'deleted':
      return <FileMinus className={cls} />
    case 'modified':
      return <FileEdit className={cls} />
    case 'renamed':
    case 'copied':
      return <FileDiff className={cls} />
    default:
      return <FileQuestion className={cls} />
  }
}

export type FileListViewProps = {
  entries: GitStatusEntry[]
  branch: string | null
  isLoading: boolean
  error: string | null
  onRefresh: () => void
  onSelectFile: (path: string) => void
}

export const FileListView = memo(function FileListView({
  entries,
  branch,
  isLoading,
  error,
  onRefresh,
  onSelectFile,
}: FileListViewProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 pb-2 pt-10">
        <p className="text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">Changes</p>
        {branch ? (
          <div className="flex items-center gap-1 text-[length:var(--fd-text-2xs)] text-fg-muted">
            <GitBranch className="h-3 w-3" />
            {branch}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="ml-auto rounded-[var(--fd-radius-sm)] p-1 text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-danger">{error}</div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            {isLoading ? (
              <LoaderCircle className="mx-auto h-5 w-5 animate-spin text-fg-faint" />
            ) : (
              'No changes detected'
            )}
          </div>
        ) : (
          <div className="py-1">
            {entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => onSelectFile(entry.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-2"
              >
                <StatusIcon status={entry.status} />
                <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)]">
                  <span className="text-fg-muted">{dirPart(entry.path)}</span>
                  <span className="font-medium text-fg-primary">{basePart(entry.path)}</span>
                </span>
                <span className="flex items-center gap-1.5 text-[length:var(--fd-text-2xs)]">
                  {entry.insertions != null ? (
                    <span className="text-success">+{entry.insertions}</span>
                  ) : null}
                  {entry.deletions != null ? (
                    <span className="text-danger">-{entry.deletions}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
})
