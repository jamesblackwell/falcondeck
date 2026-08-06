import * as React from 'react'

import { ResizableShell, ResizablePanel, ResizeHandle } from '@falcondeck/ui'

export type DesktopShellProps = {
  sidebar: React.ReactNode
  main: React.ReactNode
  rail?: React.ReactNode
  sidebarVisible?: boolean
  railVisible?: boolean
}

export function DesktopShell({
  sidebar,
  main,
  rail,
  sidebarVisible = true,
  railVisible = true,
}: DesktopShellProps) {
  return (
    <ResizableShell>
      {sidebarVisible ? (
        <>
          <ResizablePanel defaultSize="20%" minSize="200px" id="sidebar">
            {sidebar}
          </ResizablePanel>
          <ResizeHandle />
        </>
      ) : null}
      <ResizablePanel minSize="400px" id="main">
        {main}
      </ResizablePanel>
      {rail && railVisible ? (
        <>
          <ResizeHandle />
          <ResizablePanel defaultSize="25%" minSize="280px" id="rail">
            {rail}
          </ResizablePanel>
        </>
      ) : null}
    </ResizableShell>
  )
}
