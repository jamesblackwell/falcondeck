import * as React from 'react'
import { memo, useCallback, useState } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronRight, FolderClosed, FolderOpen, Globe, SquarePen } from 'lucide-react'

import type { WorkspaceSummary } from '@falcondeck/client-core'
import { workspaceColorCssVar } from '@falcondeck/client-core'
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
  /** Theme-backed categorical token, e.g. `cat-3`. */
  color?: string | null
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement> &
    React.RefAttributes<HTMLDivElement>
  /** Controlled open state; omit to let the group own it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

export const WorkspaceGroup = memo(function WorkspaceGroup({
  workspace,
  host,
  isSelected,
  onSelect,
  onNewThread,
  onOpenContextMenu,
  color,
  dragHandleProps,
  open,
  onOpenChange,
  children,
}: WorkspaceGroupProps) {
  const pathLabel = workspace.path.split('/').pop() ?? workspace.path
  const [uncontrolledOpen, setUncontrolledOpen] = useState(true)
  const isOpen = open ?? uncontrolledOpen

  // Opening a folder also selects it; closing one leaves the selection alone.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (open === undefined) setUncontrolledOpen(next)
      onOpenChange?.(next)
      if (next) onSelect()
    },
    [onOpenChange, onSelect, open],
  )

  const hostLabel = host
    ? `${host.name} · ${host.connected ? 'Connected' : 'Offline'}`
    : undefined
  const folderColor = workspaceColorCssVar(color)
  const FolderIcon = isOpen ? FolderOpen : FolderClosed

  return (
    <Collapsible.Root asChild open={isOpen} onOpenChange={handleOpenChange}>
      <section className="min-w-0 overflow-hidden">
        <div
          {...dragHandleProps}
          onClick={(event) => {
            // The drag wrapper includes the row's vertical padding. When a
            // click lands there, the trigger is not the event target, so
            // route it through the same collapse state transition.
            if (event.target === event.currentTarget) {
              handleOpenChange(!isOpen)
            }
          }}
          onContextMenu={
            onOpenContextMenu
              ? (event) => {
                  event.preventDefault()
                  onOpenContextMenu({ x: event.clientX, y: event.clientY })
                }
              : undefined
          }
          className={cn(
            'group flex w-full items-stretch gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5',
            'transition-colors duration-[var(--fd-duration-fast)]',
            // The project row is a header, not a selection target — the
            // selected thread inside it already carries the highlight, so this
            // row only shifts text weight.
            isSelected ? 'text-fg-primary' : 'text-fg-secondary',
            'hover:bg-interactive-hover hover:text-fg-primary active:bg-interactive-selected',
            dragHandleProps?.className,
          )}
        >
          {/* Stretched to the full row height (not just text height) so
              clicking anywhere in the row — not just on the label — toggles
              the collapse, matching the drag hit area on the row itself. */}
          <Collapsible.Trigger className="fd-focus-inset flex min-w-0 flex-1 items-center gap-2 rounded-[var(--fd-radius-sm)] text-left">
            {/* Folder and chevron are stacked so they can crossfade on hover
                while the chevron keeps rotating through the open/close toggle. */}
            <span className="relative h-4 w-4 shrink-0">
              <span
                aria-hidden="true"
                className={cn(
                  'absolute inset-0 transition-opacity duration-[var(--fd-duration-fast)]',
                  isOpen ? 'opacity-100 group-hover:opacity-0' : 'opacity-0',
                )}
              >
                <FolderIcon
                  className={cn(
                    'absolute inset-0 h-4 w-4',
                    folderColor ? null : 'text-fg-muted',
                  )}
                  style={folderColor ? { color: folderColor } : undefined}
                />
                {/* Remote workspaces get a small globe badge on the folder
                    instead of a separate icon or a second subtitle line. */}
                {host ? (
                  <Globe
                    className={cn(
                      'absolute -bottom-px -right-px h-2.5 w-2.5',
                      host.connected
                        ? 'text-fg-muted'
                        : 'text-fg-muted opacity-60',
                    )}
                  />
                ) : null}
              </span>
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  'absolute inset-0 h-4 w-4 text-fg-muted',
                  'transition-[transform,opacity] duration-[var(--fd-duration-normal)] ease-[var(--fd-ease-default)]',
                  isOpen
                    ? 'rotate-90 opacity-0 group-hover:opacity-100'
                    : 'rotate-0 opacity-100',
                )}
              />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-[length:var(--fd-text-sm)] font-medium">
                {pathLabel}
              </span>
              {/* Host sits quietly at the right edge of the same row: muted
                  name plus a small connection dot, no extra line. */}
              {host ? (
                <span
                  title={hostLabel}
                  className={cn(
                    'ml-auto flex min-w-0 shrink items-center gap-1.5 text-[length:var(--fd-text-xs)] text-fg-muted',
                    host.connected ? null : 'opacity-60',
                  )}
                >
                  <span className="truncate">{host.name}</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      host.connected
                        ? 'bg-[var(--color-success,#30a46c)]'
                        : 'bg-fg-muted',
                    )}
                  />
                  <span className="sr-only">
                    {host.connected ? 'Connected' : 'Offline'}
                  </span>
                </span>
              ) : null}
            </span>
          </Collapsible.Trigger>
          {onNewThread ? (
            <button
              type="button"
              data-no-workspace-drag="true"
              onClick={onNewThread}
              title={`Start new thread in ${pathLabel}`}
              aria-label={`Start new thread in ${pathLabel}`}
              className="fd-focus shrink-0 self-center rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary"
            >
              <SquarePen aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <Collapsible.Content className="min-w-0 overflow-hidden data-[state=closed]:animate-collapse-fast data-[state=open]:animate-expand-fast">
          {/* Padding lives inside the animated element: Radix measures this
              wrapper's height, so putting it on Content would make the gap pop
              in before the rows finish expanding. */}
          <div className="min-w-0 pt-1.5">{children}</div>
        </Collapsible.Content>
      </section>
    </Collapsible.Root>
  )
})
