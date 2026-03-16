import * as React from 'react'

import { cn } from '../lib/utils'
import { ScrollArea } from './scroll-area'

export function Sidebar({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <aside
      className={cn(
        'flex h-full min-h-0 flex-col rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1',
        className,
      )}
      {...props}
    >
      {children}
    </aside>
  )
}

export function SidebarHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-3 border-b border-border-subtle px-4 py-4', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export function SidebarContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('min-h-0 flex-1', className)} {...props}>
      <ScrollArea className="h-full">
        <div className="px-3 py-3">{children}</div>
      </ScrollArea>
    </div>
  )
}
