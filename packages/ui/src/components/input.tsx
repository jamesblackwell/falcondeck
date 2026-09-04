import * as React from 'react'
import { Search } from 'lucide-react'

import { cn } from '../lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'fd-focus flex h-9 w-full rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 px-3 py-2 text-[length:var(--fd-text-sm)] text-fg-primary placeholder:text-fg-muted transition-colors duration-[var(--fd-duration-fast)] focus-visible:border-border-emphasis disabled:opacity-40',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export function SearchField({
  label,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  /** Accessible name. Rendered visually hidden next to the icon. */
  label: string
}) {
  return (
    <label className={cn('relative block', className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
      />
      <span className="sr-only">{label}</span>
      <Input type="search" role="searchbox" className="pl-9" {...props} />
    </label>
  )
}
