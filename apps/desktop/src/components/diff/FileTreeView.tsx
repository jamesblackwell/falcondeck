import { memo, useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'

import type { GitStatusEntry } from '@falcondeck/client-core'

import { FileTypeIcon } from './FileTypeIcon'
import { buildFileTree, directoryPathsForMatches, type FileTreeNode } from './file-tree'

type TreeRowsProps = {
  nodes: FileTreeNode[]
  depth: number
  expanded: Set<string>
  autoExpanded: Set<string>
  statusByPath: Map<string, GitStatusEntry>
  onToggle: (path: string) => void
  onSelectFile: (path: string) => void
}

const TreeRows = memo(function TreeRows({
  nodes,
  depth,
  expanded,
  autoExpanded,
  statusByPath,
  onToggle,
  onSelectFile,
}: TreeRowsProps) {
  return nodes.map((node) => {
    const isDirectory = node.kind === 'directory'
    const isExpanded = isDirectory && (expanded.has(node.path) || autoExpanded.has(node.path))
    const status = statusByPath.get(node.path)
    return (
      <div key={node.path} role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined}>
        <button
          type="button"
          data-tree-row
          onClick={() => (isDirectory ? onToggle(node.path) : onSelectFile(node.path))}
          className="fd-focus-inset flex h-7 w-full items-center gap-1.5 truncate pr-3 text-left text-[length:var(--fd-text-sm)] text-fg-secondary [contain-intrinsic-size:28px] [content-visibility:auto] hover:bg-surface-2 hover:text-fg-primary"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {isDirectory ? (
            <>
              <ChevronRight
                aria-hidden="true"
                className={`h-3 w-3 shrink-0 text-fg-faint transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              />
              {isExpanded ? (
                <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
              ) : (
                <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
              )}
            </>
          ) : (
            <span className="ml-[18px] flex shrink-0">
              <FileTypeIcon path={node.path} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {status ? (
            <span
              className={`text-[length:var(--fd-text-2xs)] font-semibold ${
                status.status === 'added' || status.status === 'untracked'
                  ? 'text-success'
                  : status.status === 'deleted'
                    ? 'text-danger'
                    : 'text-info'
              }`}
            >
              {status.status === 'untracked' ? 'U' : status.status.slice(0, 1).toUpperCase()}
            </span>
          ) : null}
        </button>
        {isExpanded ? (
          <TreeRows
            nodes={node.children}
            depth={depth + 1}
            expanded={expanded}
            autoExpanded={autoExpanded}
            statusByPath={statusByPath}
            onToggle={onToggle}
            onSelectFile={onSelectFile}
          />
        ) : null}
      </div>
    )
  })
})

export const FileTreeView = memo(function FileTreeView({
  paths,
  statusByPath,
  query,
  onSelectFile,
}: {
  paths: string[]
  statusByPath: Map<string, GitStatusEntry>
  query: string
  onSelectFile: (path: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const tree = useMemo(() => buildFileTree(paths), [paths])
  const autoExpanded = useMemo(
    () => (query ? directoryPathsForMatches(paths) : new Set<string>()),
    [paths, query],
  )
  const onToggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-tree-row]')]
    if (rows.length === 0) return
    const index = rows.indexOf(document.activeElement as HTMLElement)
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(rows.length - 1, index + 1)
            : Math.max(0, index < 0 ? 0 : index - 1)
    event.preventDefault()
    rows[nextIndex]?.focus()
  }, [])

  return (
    <div role="tree" aria-label="Workspace files" onKeyDown={handleKeyDown}>
      <TreeRows
        nodes={tree}
        depth={0}
        expanded={expanded}
        autoExpanded={autoExpanded}
        statusByPath={statusByPath}
        onToggle={onToggle}
        onSelectFile={onSelectFile}
      />
    </div>
  )
})
