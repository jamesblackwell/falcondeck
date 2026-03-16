import {
  ArrowLeft,
  FilePlus,
  FileMinus,
  FileEdit,
  FileDiff,
  FileQuestion,
  GitBranch,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import parseDiff from 'parse-diff'
import type { Change } from 'parse-diff'

import type { createDaemonApiClient, GitFileStatus, GitStatusEntry } from '@falcondeck/client-core'
import { Button } from '@falcondeck/ui'

import { useGitStatus } from '../hooks/useGitStatus'
import { useGitDiff } from '../hooks/useGitDiff'
import { useShikiTokens } from '../hooks/useShiki'

export type DiffPanelProps = {
  api: ReturnType<typeof createDaemonApiClient> | null
  workspaceId: string | null
  refreshTrigger: number
}

function statusIcon(status: GitFileStatus) {
  switch (status) {
    case 'added':
    case 'untracked':
      return <FilePlus className="h-3.5 w-3.5 text-success" />
    case 'deleted':
      return <FileMinus className="h-3.5 w-3.5 text-danger" />
    case 'modified':
      return <FileEdit className="h-3.5 w-3.5 text-info" />
    case 'renamed':
    case 'copied':
      return <FileDiff className="h-3.5 w-3.5 text-warning" />
    default:
      return <FileQuestion className="h-3.5 w-3.5 text-fg-muted" />
  }
}

function FileListView({
  entries,
  branch,
  isLoading,
  error,
  onRefresh,
  onSelectFile,
}: {
  entries: GitStatusEntry[]
  branch: string | null
  isLoading: boolean
  error: string | null
  onRefresh: () => void
  onSelectFile: (path: string) => void
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
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
                {statusIcon(entry.status)}
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
}

/** Strip the leading +/- / space character from a diff change line */
function stripPrefix(content: string) {
  if (content.length > 0 && (content[0] === '+' || content[0] === '-' || content[0] === ' ')) {
    return content.slice(1)
  }
  return content
}

function HighlightedDiffLine({
  change,
  tokenMap,
  lineIndex,
}: {
  change: Change
  tokenMap: Map<number, import('shiki').ThemedToken[]> | null
  lineIndex: number
}) {
  const tokens = tokenMap?.get(lineIndex) ?? null
  const prefix = change.content[0] ?? ' '
  const bgClass =
    change.type === 'add'
      ? 'bg-success-muted/20'
      : change.type === 'del'
        ? 'bg-danger-muted/20'
        : ''

  return (
    <div className={`flex ${bgClass}`}>
      <span className="sticky left-0 z-10 w-7 shrink-0 select-none bg-inherit pr-0.5 text-right text-fg-faint">
        {change.type !== 'add' && 'ln1' in change ? change.ln1 : ''}
      </span>
      <span className="w-7 shrink-0 select-none pr-1 text-right text-fg-faint">
        {change.type !== 'del' && 'ln2' in change ? change.ln2 : ''}
      </span>
      <span
        className={`w-3 shrink-0 select-none text-center ${
          change.type === 'add'
            ? 'text-success'
            : change.type === 'del'
              ? 'text-danger'
              : 'text-fg-faint'
        }`}
      >
        {prefix}
      </span>
      <span className="whitespace-pre">
        {tokens ? (
          tokens.map((token, ti) => (
            <span key={ti} style={{ color: token.color }}>
              {token.content}
            </span>
          ))
        ) : (
          stripPrefix(change.content)
        )}
      </span>
    </div>
  )
}

function DiffView({
  filePath,
  diff,
  isLoading,
  error,
  onBack,
}: {
  filePath: string
  diff: string | null
  isLoading: boolean
  error: string | null
  onBack: () => void
}) {
  const parsed = useMemo(() => {
    if (!diff) return null
    if (diff.length > 200_000) return 'too-large' as const
    try {
      return parseDiff(diff)
    } catch {
      return null
    }
  }, [diff])

  // Collect all code lines (stripped of +/-) for shiki to tokenize as a single block
  const { codeLines, lineIndexMap } = useMemo(() => {
    if (!parsed || parsed === 'too-large') return { codeLines: [] as string[], lineIndexMap: new Map<number, number>() }

    const lines: string[] = []
    const indexMap = new Map<number, number>() // globalChangeIndex -> codeLineIndex
    let globalIndex = 0

    for (const file of parsed) {
      for (const chunk of file.chunks) {
        for (const change of chunk.changes) {
          indexMap.set(globalIndex, lines.length)
          lines.push(stripPrefix(change.content))
          globalIndex++
        }
      }
    }

    return { codeLines: lines, lineIndexMap: indexMap }
  }, [parsed])

  const shikiTokens = useShikiTokens(codeLines, filePath)

  // Build a map from globalChangeIndex -> ThemedToken[]
  const tokenMap = useMemo(() => {
    if (!shikiTokens) return null
    const map = new Map<number, import('shiki').ThemedToken[]>()
    for (const [globalIndex, codeLineIndex] of lineIndexMap.entries()) {
      if (codeLineIndex < shikiTokens.length) {
        map.set(globalIndex, shikiTokens[codeLineIndex])
      }
    }
    return map
  }, [shikiTokens, lineIndexMap])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-6 w-6">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
          {filePath}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <LoaderCircle className="h-5 w-5 animate-spin text-fg-faint" />
          </div>
        ) : error ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-danger">{error}</div>
        ) : parsed === 'too-large' ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            Diff too large to display
          </div>
        ) : parsed && parsed.length > 0 ? (
          <div className="font-mono text-[length:var(--fd-text-2xs)] leading-5">
            {(() => {
              let globalIndex = 0
              return parsed.map((file, fi) =>
                file.chunks.map((chunk, ci) => (
                  <div key={`${fi}-${ci}`}>
                    <div className="sticky left-0 border-y border-border-subtle bg-surface-2 px-2 py-0.5 text-fg-muted">
                      {chunk.content}
                    </div>
                    {chunk.changes.map((change, li) => {
                      const idx = globalIndex++
                      return (
                        <HighlightedDiffLine
                          key={`${fi}-${ci}-${li}`}
                          change={change}
                          tokenMap={tokenMap}
                          lineIndex={idx}
                        />
                      )
                    })}
                  </div>
                )),
              )
            })()}
          </div>
        ) : (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            {diff === '' ? 'No diff available (file may be untracked)' : 'No changes to display'}
          </div>
        )}
      </div>
    </div>
  )
}

function dirPart(path: string) {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(0, idx + 1) : ''
}

function basePart(path: string) {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

export function DiffPanel({ api, workspaceId, refreshTrigger }: DiffPanelProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
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
          onBack={() => setSelectedFile(null)}
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
        onSelectFile={setSelectedFile}
      />
    </div>
  )
}
