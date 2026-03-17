import { Group, Panel, Separator } from 'react-resizable-panels'
import * as React from 'react'

import { cn } from '../lib/utils'

export function ResizableShell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('relative h-screen overflow-hidden bg-surface-0', className)}>
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-[38px]" />
      <div className="h-full">
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

export function ResizeHandle({ className }: { className?: string }) {
  return (
    <Separator
      className={cn(
        'group relative flex w-[1px] items-stretch justify-center outline-none',
        className,
      )}
    >
      <div className="h-full w-[1px] bg-border-default transition-all duration-[var(--fd-duration-fast)] group-hover:w-[3px] group-hover:bg-border-hover group-data-[resize-handle-state=drag]:w-[3px] group-data-[resize-handle-state=drag]:bg-accent" />
    </Separator>
  )
}
