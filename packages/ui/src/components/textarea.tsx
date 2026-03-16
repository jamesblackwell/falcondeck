import * as React from 'react'

import { cn } from '../lib/utils'

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[80px] w-full rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-2 px-4 py-3 text-[length:var(--fd-text-sm)] text-fg-primary placeholder:text-fg-muted transition-colors duration-[var(--fd-duration-fast)] focus-visible:border-border-emphasis focus-visible:outline-none disabled:opacity-40',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'
