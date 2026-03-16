import * as React from 'react'

import { cn } from '../lib/utils'

export function Toolbar({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-border-subtle px-4 py-2.5',
        className,
      )}
      {...props}
    />
  )
}

export function ToolbarGroup({
  className,
  align,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { align?: 'start' | 'end' }) {
  return (
    <div
      className={cn('flex items-center gap-2', align === 'end' && 'ml-auto', className)}
      {...props}
    />
  )
}
