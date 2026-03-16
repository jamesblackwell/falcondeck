import * as React from 'react'

import { cn } from '../lib/utils'

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-[var(--fd-radius-md)] bg-surface-3', className)}
      {...props}
    />
  )
}
