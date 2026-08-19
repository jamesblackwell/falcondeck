import * as React from 'react'

import { Kbd } from './kbd'
import { cn } from '../lib/utils'

/**
 * Menu title row with its opening shortcut rendered as keycaps on the right.
 * Shared by the composer's popovers and selects so every menu teaches its
 * own binding in the same spot. Padding is left to the caller because each
 * surface insets its header differently.
 */
export function MenuHeader({
  label,
  shortcut,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  label: string
  /** Binding tokens ("⌃", "⇧", "M"), one keycap each; omitted renders title only. */
  shortcut?: string[]
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2', className)} {...props}>
      <p className="truncate text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
        {label}
      </p>
      {shortcut?.length ? (
        <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
          {shortcut.map((token, index) => (
            <Kbd key={`${token}-${index}`}>{token}</Kbd>
          ))}
        </span>
      ) : null}
    </div>
  )
}
