import * as React from 'react'
import { memo, useState } from 'react'
import { ChevronDown, ChevronRight, FolderClosed, Globe, SquarePen } from 'lucide-react'

import type { WorkspaceSummary } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

// Present when the workspace lives on an enrolled remote server rather than
// this machine; rendered as a host subtitle with a connection dot.
export type WorkspaceHostBadge = {
  name: string
  connected: boolean
}

export type WorkspaceGroupProps = {
  workspace: WorkspaceSummary
  host?: WorkspaceHostBadge | null
  isSelected: boolean
  onSelect: () => void
  onNewThread?: () => void
  onOpenContextMenu?: (position: { x: number; y: number }) => void
  children: React.ReactNode
}

export const WorkspaceGroup = memo(function WorkspaceGroup({
  workspace,
  host,
  isSelected,
  onSelect,
  onNewThread,
  onOpenContextMenu,
  children,
}: WorkspaceGroupProps) {
  const pathLabel = workspace.path.split('/').pop() ?? workspace.path
  const [isOpen, setIsOpen] = useState(true)

  return (
    <section className="min-w-0 overflow-hidden">
      <div
        onContextMenu={
          onOpenContextMenu
            ? (event) => {
                event.preventDefault()
                onOpenContextMenu({ x: event.clientX, y: event.clientY })
              }
            : undefined
        }
        className={cn(
          'group flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5',
          isSelected
            ? 'bg-surface-2 text-fg-primary'
            : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
        )}
      >
        <button
          type="button"
          aria-expanded={isOpen}
          className="fd-focus-inset flex min-w-0 flex-1 items-center gap-2 rounded-[var(--fd-radius-sm)] text-left"
          onClick={() => {
            if (isOpen) {
              setIsOpen(false)
            } else {
              setIsOpen(true)
              onSelect()
            }
          }}
        >
          <span className="relative h-4 w-4 shrink-0">
            {isOpen ? (
              <>
                {host ? (
                  <Globe className="h-4 w-4 text-fg-muted group-hover:hidden" />
                ) : (
                  <FolderClosed className="h-4 w-4 text-fg-muted group-hover:hidden" />
                )}
                <ChevronDown className="hidden h-4 w-4 text-fg-muted group-hover:block" />
              </>
            ) : (
              <ChevronRight className="h-4 w-4 text-fg-muted" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[length:var(--fd-text-sm)] font-medium">
              {pathLabel}
            </span>
            {host ? (
              <span className="mt-0.5 flex items-center gap-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    host.connected ? 'bg-[var(--color-success,#30a46c)]' : 'bg-fg-muted',
                  )}
                />
                <span className="truncate">
                  {host.name} · {host.connected ? 'Connected' : 'Offline'}
                </span>
              </span>
            ) : null}
          </span>
        </button>
        {onNewThread ? (
          <button
            type="button"
            onClick={onNewThread}
            title={`Start new thread in ${pathLabel}`}
            aria-label={`Start new thread in ${pathLabel}`}
            className="fd-focus shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
          >
            <SquarePen aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {isOpen ? (
        <div className="min-w-0">
          {children}
        </div>
      ) : null}
    </section>
  )
})
