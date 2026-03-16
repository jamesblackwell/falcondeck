import * as React from 'react'

import { ResizableShell, ResizablePanel, ResizeHandle } from '@falcondeck/ui'

export type DesktopShellProps = {
  sidebar: React.ReactNode
  main: React.ReactNode
  rail?: React.ReactNode
}

export function DesktopShell({ sidebar, main, rail }: DesktopShellProps) {
  return (
    <ResizableShell>
      <ResizablePanel defaultSize="20%" minSize="200px" id="sidebar">
        {sidebar}
      </ResizablePanel>
      <ResizeHandle />
      <ResizablePanel minSize="400px" id="main">
        {main}
      </ResizablePanel>
      {rail ? (
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
