import * as React from 'react'
import { memo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ListFilter } from 'lucide-react'

import type { ThreadTag } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

const THREAD_COLOR_VALUES: Record<string, string> = {
  gray: '#94a3b8',
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
}

/** Compact colour filter kept beside the Projects sort control. */
export const ThreadColorFilterMenu = memo(function ThreadColorFilterMenu({
  options,
  selectedIds,
  onToggle,
  onClear,
}: {
  options: ThreadTag[]
  selectedIds: ReadonlySet<string>
  onToggle: (tagId: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const active = selectedIds.size > 0

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
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]',
      ),
    )
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    )
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
          title={
            active
              ? `Filter chats by colour (${selectedIds.size} active)`
              : 'Filter chats by colour'
          }
          aria-label="Filter chats by colour"
          className={cn(
            'fd-focus relative -my-0.5 shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary',
            open || active ? 'bg-surface-3 text-fg-secondary' : 'text-fg-muted',
          )}
        >
          <ListFilter aria-hidden="true" className="h-3.5 w-3.5" />
          {active ? (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent"
            />
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 w-56 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
        >
          <div
            role="menu"
            aria-label="Filter chats by colour"
            onKeyDown={handleMenuKeyDown}
          >
            <div className="mx-1 mb-1 flex h-9 items-center justify-between gap-3 border-b border-border-subtle px-1.5">
              <p className="whitespace-nowrap text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
                Filter by colour
              </p>
              {active ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={onClear}
                  className="fd-focus-fill shrink-0 rounded-[var(--fd-radius-sm)] px-1.5 py-1 text-[length:var(--fd-text-xs)] text-fg-muted hover:bg-surface-3 hover:text-fg-secondary focus-visible:bg-surface-3 focus-visible:text-fg-secondary"
                >
                  Clear
                </button>
              ) : null}
            </div>
            {options.map((option) => {
              const selected = selectedIds.has(option.id)
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={selected}
                  onClick={() => onToggle(option.id)}
                  className="fd-focus-fill flex h-8 w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3 focus-visible:bg-surface-3"
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        THREAD_COLOR_VALUES[option.color] ??
                        THREAD_COLOR_VALUES.gray,
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                  </span>
                  <Check
                    aria-hidden="true"
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      selected ? 'text-fg-primary' : 'invisible',
                    )}
                  />
                </button>
              )
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
})
