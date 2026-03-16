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
    <div
      className={cn(
        'grid min-h-screen gap-3 p-3',
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
  )
}
