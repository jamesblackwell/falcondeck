import { Group, Panel, Separator, type PanelImperativeHandle } from 'react-resizable-panels'
import * as React from 'react'

import { cn } from '../lib/utils'

/** Kept in sync with `--fd-duration-panel` in styles.css. */
export const PANEL_TRANSITION_MS = 220

export function ResizableShell({
  children,
  className,
  animating = false,
}: {
  children: React.ReactNode
  className?: string
  /**
   * True while a panel is collapsing or expanding. Only then do panels get a
   * flex transition — leaving it on permanently would make separator drags
   * lag a frame behind the pointer.
   */
  animating?: boolean
}) {
  return (
    // Window dragging is owned by the pane headers (`data-tauri-drag-region`
    // on each one) rather than an overlay strip: an overlay across the top of
    // the window paints above those headers and swallows clicks on any control
    // sitting in the first 28px, which is most of a 48px header.
    <div className={cn('relative h-screen overflow-hidden bg-surface-0', className)}>
      <div className="h-full" data-fd-shell="" data-animating={animating ? '' : undefined}>
        <Group orientation="horizontal">
          {children}
        </Group>
      </div>
    </div>
  )
}

export function ResizablePanel({
  children,
  className,
  defaultSize,
  minSize,
  ...props
}: {
  children: React.ReactNode
  className?: string
  defaultSize?: number | string
  minSize?: number | string
  id?: string
}) {
  return (
    <Panel
      defaultSize={defaultSize}
      minSize={minSize}
      className={cn('min-h-0', className)}
      {...props}
    >
      {children}
    </Panel>
  )
}

/**
 * A side panel that collapses to zero width instead of unmounting, so the
 * shell can animate the width change. Content keeps its full width while the
 * panel shrinks and is anchored to the outer edge, which reads as the panel
 * sliding off screen rather than its contents being squeezed.
 */
export function ResizableSidePanel({
  children,
  open,
  side,
  className,
  contentWidth,
  defaultSize,
  minSize,
  id,
  onCollapsedByDrag,
}: {
  children: React.ReactNode
  open: boolean
  side: 'left' | 'right'
  className?: string
  /** Width the content holds onto while the panel animates shut. */
  contentWidth: string
  defaultSize?: number | string
  minSize?: number | string
  id?: string
  /** Fired when a separator drag pushes the panel past its collapse threshold. */
  onCollapsedByDrag?: () => void
}) {
  const panelRef = React.useRef<PanelImperativeHandle | null>(null)
  const openRef = React.useRef(open)
  openRef.current = open
  // Size to restore on expand: whatever width the panel last had while open.
  const openSize = React.useRef<number | string | undefined>(defaultSize)
  // Mounting already reflects `open` through defaultSize, and the imperative
  // handle is not usable until the parent Group has registered this panel.
  const mountedOpen = React.useRef(open)
  // Frozen at mount: after that the panel size is driven imperatively, and a
  // changing defaultSize would fight those calls.
  const initialSize = React.useRef(open ? defaultSize : '0%').current

  React.useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel || mountedOpen.current === open) return
    mountedOpen.current = open
    if (open) {
      panel.resize(openSize.current ?? '20%')
    } else {
      panel.collapse()
    }
  }, [open])

  return (
    <Panel
      panelRef={panelRef}
      collapsible
      collapsedSize="0%"
      defaultSize={initialSize}
      minSize={minSize}
      id={id}
      className={cn('relative min-h-0', className)}
      // Panel applies its own inline `overflow: auto`, so clipping the
      // sliding content has to be set here rather than via a class.
      style={{ overflow: 'hidden' }}
      onResize={(size) => {
        // Percentage comes from the layout model; pixels read the live
        // element, which lags behind during the collapse transition.
        if (size.asPercentage > 0) {
          openSize.current = `${size.asPercentage}%`
          return
        }
        // A drag past the collapse threshold is the user closing the panel;
        // tell the owner so the toggle button and shortcut stay in sync.
        if (openRef.current) onCollapsedByDrag?.()
      }}
    >
      <div
        className={cn(
          'absolute inset-y-0 flex w-full [&>*]:min-w-0 [&>*]:flex-1',
          'transition-opacity duration-[var(--fd-duration-fast)] ease-[var(--fd-ease-default)]',
          side === 'left' ? 'right-0' : 'left-0',
          open ? 'opacity-100' : 'opacity-0',
        )}
        style={{ minWidth: contentWidth }}
        inert={!open ? true : undefined}
      >
        {children}
      </div>
    </Panel>
  )
}

export function ResizeHandle({
  className,
  collapsed = false,
}: {
  className?: string
  collapsed?: boolean
}) {
  return (
    <Separator
      disabled={collapsed}
      className={cn(
        'group relative flex items-stretch justify-center outline-none transition-[width] duration-[var(--fd-duration-panel)] ease-[var(--fd-ease-panel)]',
        collapsed ? 'pointer-events-none w-0' : 'w-[1px]',
        className,
      )}
    >
      <div
        className={cn(
          'h-full w-[1px] bg-border-default transition-all duration-[var(--fd-duration-fast)] group-hover:w-[3px] group-hover:bg-border-hover group-data-[resize-handle-state=drag]:w-[3px] group-data-[resize-handle-state=drag]:bg-accent',
          collapsed && 'opacity-0',
        )}
      />
    </Separator>
  )
}
