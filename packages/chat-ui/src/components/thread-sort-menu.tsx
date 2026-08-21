import * as React from 'react'
import { memo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ArrowUpDown, Check } from 'lucide-react'

import { THREAD_SORT_OPTIONS, type ThreadSortMode } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

/**
 * The "Sort chats by" menu on the Projects heading. Orders every project's
 * thread list (and the pinned section) at once; the choice is a device-local
 * view preference owned by the embedding app.
 */
export const ThreadSortMenu = memo(function ThreadSortMenu({
  value,
  onChange,
}: {
  value: ThreadSortMode
  onChange: (mode: ThreadSortMode) => void
}) {
  const [open, setOpen] = useState(false)

  // Radix Popover handles dismissal and focus return; arrow keys are what the
  // `menu` role promises assistive tech, so those are wired up by hand.
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    )
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Sort chats"
          aria-label="Sort chats"
          className={cn(
            'fd-focus -my-0.5 shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary',
            open ? 'bg-surface-3 text-fg-secondary' : 'text-fg-muted',
          )}
        >
          <ArrowUpDown aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 w-48 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
        >
          <div role="menu" aria-label="Sort chats by" onKeyDown={handleMenuKeyDown}>
            <p className="px-2.5 pb-1 pt-1.5 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
              Sort chats by
            </p>
            {THREAD_SORT_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                role="menuitemradio"
                aria-checked={value === option.mode}
                onClick={() => {
                  onChange(option.mode)
                  setOpen(false)
                }}
                className="fd-focus-fill flex h-9 w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3 focus-visible:bg-surface-3"
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    value === option.mode ? 'text-fg-primary' : 'invisible',
                  )}
                />
                {option.label}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
})
