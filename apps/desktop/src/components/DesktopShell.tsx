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
  sidebarVisible?: boolean
  railVisible?: boolean
  onSidebarCollapsedByDrag?: () => void
  onRailCollapsedByDrag?: () => void
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

export function DesktopShell({
  sidebar,
  main,
  rail,
  sidebarVisible = true,
  railVisible = true,
  onSidebarCollapsedByDrag,
  onRailCollapsedByDrag,
}: DesktopShellProps) {
  const railOpen = Boolean(rail) && railVisible
  const animating = useToggleAnimation([sidebarVisible, railOpen])

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

  return (
    <ResizableShell animating={animating}>
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
}
