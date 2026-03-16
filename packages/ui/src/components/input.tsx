import * as React from 'react'

import { cn } from '../lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 px-3 py-2 text-[length:var(--fd-text-sm)] text-fg-primary placeholder:text-fg-muted transition-colors duration-[var(--fd-duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 disabled:opacity-40',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
