import * as React from 'react'

import { cn } from '../lib/utils'

export type AppShellProps = {
  sidebar: React.ReactNode
  main: React.ReactNode
  rail?: React.ReactNode
  className?: string
}

export function AppShell({ sidebar, main, rail, className }: AppShellProps) {
  return (
    <div className="relative h-screen overflow-hidden bg-surface-0">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-50 h-[40px]" />
      <div
        className={cn(
          'grid h-full gap-3 pb-3 pl-3 pr-3 pt-[40px]',
          rail
            ? 'grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_320px]'
            : 'grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]',
          className,
        )}
      >
        {sidebar}
        {main}
        {rail}
      </div>
    </div>
  )
}
