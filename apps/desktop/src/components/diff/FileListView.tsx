import { memo, useDeferredValue, useMemo, useState } from 'react'
import {
  GitBranch,
  RefreshCw,
  ScanSearch,
  Search,
  X,
} from 'lucide-react'

import type { GitStatusEntry } from '@falcondeck/client-core'
import { ActivityDiamond } from '@falcondeck/ui'

import { useVirtualRows } from '../../hooks/useVirtualRows'
import { FileTreeView } from './FileTreeView'
import { FileTypeIcon } from './FileTypeIcon'
import { InfoView, type ReviewInfoContext } from './InfoView'
import { basePart, dirPart, statusLabel, statusToneClass } from './diff-utils'

export type ReviewPanelTab = 'info' | 'changes' | 'files'

export type FileListViewProps = {
  entries: GitStatusEntry[]
  files: string[]
  filesTruncated: boolean
  branch: string | null
  activeTab: ReviewPanelTab
  isLoading: boolean
  isFilesLoading: boolean
  error: string | null
  filesError: string | null
  onTabChange: (tab: ReviewPanelTab) => void
  onRefresh: () => void
  onRefreshFiles: () => void
  onSelectChangedFile: (entry: GitStatusEntry) => void
  onSelectWorkspaceFile: (path: string) => void
  onStartReview?: (() => void) | null
  isReviewPending?: boolean
  /** Context for the overview tab; omitted only by callers without a workspace. */
  info?: ReviewInfoContext | null
}

const ROW_HEIGHT = 32
const LIST_PADDING = 8

const FileRow = memo(function FileRow({
  entry,
  onSelect,
}: {
  entry: GitStatusEntry
  onSelect: (entry: GitStatusEntry) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      className="fd-focus-inset flex h-8 w-full items-center gap-2 px-3 text-left hover:bg-surface-2"
    >
      <FileTypeIcon path={entry.path} />
      <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)]">
        <span className="text-fg-muted">{dirPart(entry.path)}</span>
        <span className="font-medium text-fg-primary">{basePart(entry.path)}</span>
      </span>
      <span className="flex items-center gap-1.5 text-[length:var(--fd-text-xs)] tabular-nums">
        {entry.insertions != null ? <span className="text-success">+{entry.insertions}</span> : null}
        {entry.deletions != null ? <span className="text-danger">-{entry.deletions}</span> : null}
        <span className={statusToneClass(entry.status)}>{statusLabel(entry.status)}</span>
      </span>
    </button>
  )
})

export const FileListView = memo(function FileListView({
  entries,
  files,
  filesTruncated,
  branch,
  activeTab,
  isLoading,
  isFilesLoading,
  error,
  filesError,
  onTabChange,
  onRefresh,
  onRefreshFiles,
  onSelectChangedFile,
  onSelectWorkspaceFile,
  onStartReview = null,
  isReviewPending = false,
  info = null,
}: FileListViewProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const statusByPath = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry])),
    [entries],
  )
  const filteredEntries = useMemo(
    () =>
      deferredQuery
        ? entries.filter((entry) => entry.path.toLowerCase().includes(deferredQuery))
        : entries,
    [deferredQuery, entries],
  )
  const filteredFiles = useMemo(() => {
    if (!deferredQuery) return files
    const matches: string[] = []
    for (const path of files) {
      if (path.toLowerCase().includes(deferredQuery)) matches.push(path)
      if (matches.length === 500) break
    }
    return matches
  }, [deferredQuery, files])
  const rows = useVirtualRows(filteredEntries.length, ROW_HEIGHT)
  // The overview reads the same git status the changes tab does, so it shares
  // that tab's loading and error state rather than owning one of its own.
  const activeError = activeTab === 'files' ? filesError : error
  const activeLoading = activeTab === 'files' ? isFilesLoading : isLoading
  const tabs = (info ? ['info', 'changes', 'files'] : ['changes', 'files']) as ReviewPanelTab[]

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border-subtle px-3 pb-2 pt-2">
        <div className="flex h-7 items-center gap-2">
          <p className="text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">Review</p>
          {/* The overview spells the branch out in its own row. */}
          {branch && activeTab !== 'info' ? (
            <div className="flex min-w-0 items-center gap-1 text-[length:var(--fd-text-xs)] text-fg-muted">
              <GitBranch aria-hidden="true" className="h-3 w-3 shrink-0" />
              <span className="truncate">{branch}</span>
            </div>
          ) : null}
          <div className="ml-auto" />
          {activeTab === 'changes' && onStartReview && entries.length > 0 ? (
            <button
              type="button"
              onClick={onStartReview}
              disabled={isReviewPending}
              title="Review uncommitted changes"
              aria-label="Review uncommitted changes"
              aria-busy={isReviewPending}
              className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
            >
              {isReviewPending ? (
                <ActivityDiamond tone="current" />
              ) : (
                <ScanSearch aria-hidden="true" className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={activeTab === 'files' ? onRefreshFiles : onRefresh}
            disabled={activeLoading}
            title={`Refresh ${activeTab}`}
            aria-label={`Refresh ${activeTab}`}
            aria-busy={activeLoading}
            className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
          >
            {activeLoading ? (
              <ActivityDiamond tone="current" />
            ) : (
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="mt-1 flex items-center gap-1 border-b border-border-subtle">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                onTabChange(tab)
                setQuery('')
              }}
              aria-pressed={activeTab === tab}
              className={`fd-focus -mb-px border-b px-2 py-1.5 text-[length:var(--fd-text-sm)] font-medium capitalize transition-colors ${
                activeTab === tab
                  ? 'border-accent text-fg-primary'
                  : 'border-transparent text-fg-muted hover:text-fg-secondary'
              }`}
            >
              {tab}
              {tab === 'changes' && entries.length > 0 ? (
                <span className="fd-type-meta ml-1 text-fg-muted">
                  {entries.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {activeTab === 'info' ? null : (
          <label className="mt-2 flex h-7 items-center gap-1.5 rounded-[var(--fd-radius-sm)] border border-border-default bg-surface-0 px-2 focus-within:border-border-strong">
            <Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
            <span className="sr-only">Filter {activeTab}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={activeTab === 'changes' ? 'Filter changed files' : 'Go to file'}
              className="min-w-0 flex-1 bg-transparent text-[length:var(--fd-text-sm)] text-fg-primary outline-none placeholder:text-fg-faint"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear filter"
                className="fd-focus rounded-[var(--fd-radius-sm)] text-fg-faint hover:text-fg-secondary"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </label>
        )}
      </div>

      <div
        ref={rows.containerRef}
        onScroll={rows.onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {activeTab === 'info' && info ? (
          <InfoView
            info={info}
            entries={entries}
            branch={branch}
            isLoading={isLoading}
            error={error}
            onSelectChangedFile={onSelectChangedFile}
          />
        ) : activeError ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-danger">
            {activeError}
          </div>
        ) : activeTab === 'changes' ? (
          filteredEntries.length === 0 ? (
            <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
              {isLoading ? (
                <ActivityDiamond size="lg" className="mx-auto flex" />
              ) : deferredQuery ? (
                'No matching changes'
              ) : (
                'No changes detected'
              )}
            </div>
          ) : (
            <div className="relative" style={{ height: rows.totalHeight + LIST_PADDING }}>
              <div
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${rows.offsetY + LIST_PADDING / 2}px)` }}
              >
                {filteredEntries.slice(rows.start, rows.end).map((entry) => (
                  <FileRow key={entry.path} entry={entry} onSelect={onSelectChangedFile} />
                ))}
              </div>
            </div>
          )
        ) : isFilesLoading && files.length === 0 ? (
          <ActivityDiamond size="lg" className="mx-auto mt-8 flex" />
        ) : filteredFiles.length === 0 ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            {deferredQuery ? 'No matching files' : 'No files found'}
          </div>
        ) : (
          <>
            {filesTruncated ? (
              <p className="border-b border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-2xs)] text-warning">
                Showing the first 20,000 files
              </p>
            ) : null}
            <FileTreeView
              paths={filteredFiles}
              statusByPath={statusByPath}
              query={deferredQuery}
              onSelectFile={onSelectWorkspaceFile}
            />
          </>
        )}
      </div>
    </div>
  )
})
