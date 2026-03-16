import * as React from 'react'

import { cn } from '../lib/utils'

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center rounded-[var(--fd-radius-sm)] border border-border-default bg-surface-2 px-1.5 py-0.5 font-mono text-[length:var(--fd-text-2xs)] text-fg-tertiary',
        className,
      )}
      {...props}
    />
  )
}
