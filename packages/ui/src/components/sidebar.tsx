import * as React from 'react'

import { cn } from '../lib/utils'
import { ScrollArea } from './scroll-area'

export function Sidebar({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <aside
      className={cn(
        'flex h-full min-h-0 flex-col bg-surface-1',
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
      className={cn('flex flex-col gap-3 border-b border-border-subtle px-4 pb-3 pt-11', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export function SidebarContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('min-h-0 min-w-0 flex-1 overflow-hidden', className)} {...props}>
      <ScrollArea className="h-full">
        <div className="px-3 py-3 overflow-hidden">{children}</div>
      </ScrollArea>
    </div>
  )
}
