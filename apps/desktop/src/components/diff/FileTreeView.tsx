import { memo, useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'

import type { GitStatusEntry } from '@falcondeck/client-core'

import { FileTypeIcon } from './FileTypeIcon'
import { buildFileTree, directoryPathsForMatches, type FileTreeNode } from './file-tree'

type VisibleRow = {
  node: FileTreeNode
  depth: number
  parent: string | null
  position: number
  size: number
}

export const FileTreeView = memo(function FileTreeView({
  paths,
  statusByPath,
  query,
  onSelectFile,
  onOpenContextMenu,
  expanded,
  onExpandedChange,
}: {
  paths: string[]
  statusByPath: Map<string, GitStatusEntry>
  query: string
  onSelectFile: (path: string) => void
  onOpenContextMenu: (
    path: string,
    kind: FileTreeNode['kind'],
    position: { x: number; y: number },
  ) => void
  expanded: Set<string>
  onExpandedChange: (next: Set<string>) => void
}) {
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  // Search disclosures are independent of the browsing tree. Clearing a search
  // restores the user's original folder expansion rather than opening everything.
  const [searchDisclosure, setSearchDisclosure] = useState({
    query,
    collapsed: new Set<string>(),
  })
  const collapsed =
    searchDisclosure.query === query ? searchDisclosure.collapsed : new Set<string>()
  const tree = useMemo(() => buildFileTree(paths), [paths])
  const autoExpanded = useMemo(
    () => (query ? directoryPathsForMatches(paths) : new Set<string>()),
    [paths, query],
  )
  const isExpanded = (path: string) =>
    query ? autoExpanded.has(path) && !collapsed.has(path) : expanded.has(path)
  const rows: VisibleRow[] = []
  const visit = (nodes: FileTreeNode[], depth: number, parent: string | null) => {
    nodes.forEach((node, index) => {
      rows.push({
        node,
        depth,
        parent,
        position: index + 1,
        size: nodes.length,
      })
      if (node.kind === 'directory' && isExpanded(node.path))
        visit(node.children, depth + 1, node.path)
    })
  }
  visit(tree, 0, null)
  const tabPath = rows.some(({ node }) => node.path === focusedPath)
    ? focusedPath
    : rows[0]?.node.path
  const toggle = (path: string) => {
    const next = new Set(query ? collapsed : expanded)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    if (query) setSearchDisclosure({ query, collapsed: next })
    else onExpandedChange(next)
  }
  const focusRow = useCallback((element: HTMLElement | undefined) => {
    element?.focus()
  }, [])
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-tree-row]')]
    const index = elements.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    const row = rows[index]
    if (!row) return
    let target: number | undefined
    switch (event.key) {
      case 'Home':
        target = 0
        break
      case 'End':
        target = rows.length - 1
        break
      case 'ArrowDown':
        target = Math.min(rows.length - 1, index + 1)
        break
      case 'ArrowUp':
        target = Math.max(0, index - 1)
        break
      case 'ArrowRight':
        if (row.node.kind === 'directory') {
          if (!isExpanded(row.node.path)) toggle(row.node.path)
          else if (rows[index + 1]?.parent === row.node.path) target = index + 1
        }
        break
      case 'ArrowLeft':
        if (row.node.kind === 'directory' && isExpanded(row.node.path)) toggle(row.node.path)
        else if (row.parent) target = rows.findIndex(({ node }) => node.path === row.parent)
        break
      default:
        return
    }
    event.preventDefault()
    if (target != null) focusRow(elements[target])
  }

  return (
    <div role="tree" aria-label="Workspace files" onKeyDown={handleKeyDown}>
      {rows.map(({ node, depth, position, size }) => {
        const isDirectory = node.kind === 'directory'
        const open = isDirectory && isExpanded(node.path)
        const status = statusByPath.get(node.path)
        return (
          <div key={node.path}>
            <button
              role="treeitem"
              aria-label={node.name}
              aria-level={depth + 1}
              aria-posinset={position}
              aria-setsize={size}
              aria-expanded={isDirectory ? open : undefined}
              type="button"
              data-tree-row
              tabIndex={tabPath === node.path ? 0 : -1}
              title={node.path}
              aria-haspopup="menu"
              onFocus={() => setFocusedPath(node.path)}
              onClick={() => (isDirectory ? toggle(node.path) : onSelectFile(node.path))}
              onContextMenu={(event) => {
                event.preventDefault()
                event.currentTarget.focus()
                onOpenContextMenu(node.path, node.kind, {
                  x: event.clientX,
                  y: event.clientY,
                })
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                event.preventDefault()
                const rect = event.currentTarget.getBoundingClientRect()
                onOpenContextMenu(node.path, node.kind, {
                  x: rect.left,
                  y: rect.bottom,
                })
              }}
              className="fd-focus-inset flex h-7 w-full items-center gap-1.5 truncate pr-3 text-left text-[length:var(--fd-text-sm)] text-fg-secondary [contain-intrinsic-size:28px] [content-visibility:auto] hover:bg-surface-2 hover:text-fg-primary"
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              {isDirectory ? (
                <>
                  <ChevronRight
                    aria-hidden="true"
                    className={`h-3 w-3 shrink-0 text-fg-faint transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  {open ? (
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
          </div>
        )
      })}
    </div>
  )
})
