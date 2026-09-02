import * as React from 'react'

import {
  PANEL_TRANSITION_MS,
  ResizableShell,
  ResizablePanel,
  ResizableSidePanel,
  ResizeHandle,
} from '@falcondeck/ui'

export type DesktopShellProps = {
  sidebar: React.ReactNode
  main: React.ReactNode
  rail?: React.ReactNode
  bottom?: React.ReactNode
  sidebarVisible?: boolean
  railVisible?: boolean
  onSidebarCollapsedByDrag?: () => void
  onRailCollapsedByDrag?: () => void
}

const BOTTOM_PANEL_DEFAULT_HEIGHT = 320
const BOTTOM_PANEL_MIN_HEIGHT = 140
const BOTTOM_PANEL_MAX_VIEWPORT_SHARE = 0.7

function clampBottomHeight(height: number): number {
  const max = Math.round(window.innerHeight * BOTTOM_PANEL_MAX_VIEWPORT_SHARE)
  return Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.min(max, height))
}

/**
 * True for one transition's worth of time after any of `keys` changes, so the
 * shell can arm its flex transition only while a panel is actually moving.
 */
function useToggleAnimation(keys: unknown[]) {
  const [animating, setAnimating] = React.useState(false)
  const firstRun = React.useRef(true)

  React.useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    setAnimating(true)
    const timer = setTimeout(() => setAnimating(false), PANEL_TRANSITION_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, keys)

  return animating
}

/** Drag handle growing the bottom panel upward; shrink when dragged down. */
function BottomResizeHandle({
  height,
  onHeightChange,
}: {
  height: number
  onHeightChange: (height: number) => void
}) {
  const dragState = React.useRef<{ pointerId: number; startY: number; startHeight: number } | null>(
    null,
  )

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragState.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current
    if (!drag || drag.pointerId !== event.pointerId) return
    onHeightChange(clampBottomHeight(drag.startHeight + (drag.startY - event.clientY)))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return
    dragState.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      data-bottom-panel-resize=""
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="h-1 shrink-0 cursor-row-resize bg-surface-0 hover:bg-border-default"
    />
  )
}

export function DesktopShell({
  sidebar,
  main,
  rail,
  bottom,
  sidebarVisible = true,
  railVisible = true,
  onSidebarCollapsedByDrag,
  onRailCollapsedByDrag,
}: DesktopShellProps) {
  const railOpen = Boolean(rail) && railVisible
  const animating = useToggleAnimation([sidebarVisible, railOpen])
  const [bottomHeight, setBottomHeight] = React.useState(BOTTOM_PANEL_DEFAULT_HEIGHT)

  // The rail's contents poll git state, so they are torn down once the close
  // animation has finished rather than kept alive behind a zero-width panel.
  const [railMounted, setRailMounted] = React.useState(railOpen)
  React.useEffect(() => {
    if (railOpen) {
      setRailMounted(true)
      return
    }
    const timer = setTimeout(() => setRailMounted(false), PANEL_TRANSITION_MS)
    return () => clearTimeout(timer)
  }, [railOpen])

  const shell = (
    <ResizableShell animating={animating} className={bottom ? 'h-full' : undefined}>
      <ResizableSidePanel
        id="sidebar"
        side="left"
        open={sidebarVisible}
        defaultSize="20%"
        minSize="200px"
        contentWidth="200px"
        onCollapsedByDrag={onSidebarCollapsedByDrag}
      >
        {sidebar}
      </ResizableSidePanel>
      <ResizeHandle collapsed={!sidebarVisible} />
      <ResizablePanel minSize="400px" id="main">
        {main}
      </ResizablePanel>
      {/* The rail panel stays in the group even with no rail to show. Taking
          it out re-normalises the group's sizes, which springs a collapsed
          sidebar back open the moment a takeover view hides the rail. */}
      <ResizeHandle collapsed={!railOpen} />
      <ResizableSidePanel
        id="rail"
        side="right"
        open={railOpen}
        defaultSize="25%"
        minSize="280px"
        contentWidth="280px"
        onCollapsedByDrag={onRailCollapsedByDrag}
      >
        {rail && railMounted ? rail : null}
      </ResizableSidePanel>
    </ResizableShell>
  )

  if (!bottom) return shell

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col [&>*]:min-h-0">{shell}</div>
      <BottomResizeHandle height={bottomHeight} onHeightChange={setBottomHeight} />
      <div style={{ height: bottomHeight }} className="min-h-0 shrink-0 overflow-hidden">
        {bottom}
      </div>
    </div>
  )
}
