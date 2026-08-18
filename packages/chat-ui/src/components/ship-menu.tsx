import * as React from 'react'
import { memo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, GitMerge, GitPullRequest, GitPullRequestDraft, Loader2 } from 'lucide-react'

import type { ShipThreadMode, ThreadSummary } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

import { MergeFailureDialog } from './merge-failure-dialog'

/**
 * The default click. FalconDeck's project folder is usually dirty, so the
 * primary action opens a pull request rather than merging over live work.
 */
const DEFAULT_MODE: ShipThreadMode = 'pr'

type ShipAction = {
  mode: ShipThreadMode
  label: string
  hint: string
  icon: typeof GitMerge
}

const ACTIONS: ShipAction[] = [
  {
    mode: 'pr',
    label: 'Create pull request',
    hint: 'Push the branch and open a PR',
    icon: GitPullRequest,
  },
  {
    mode: 'draft_pr',
    label: 'Draft pull request',
    hint: 'Same, opened as a draft',
    icon: GitPullRequestDraft,
  },
  {
    mode: 'merge',
    label: 'Merge and push',
    hint: 'Merge into the base branch, then push',
    icon: GitMerge,
  },
]

export type ShipMenuProps = {
  thread: ThreadSummary | null
  /** Runs the chosen mode. Rejections are surfaced by the embedding app. */
  onShip: (mode: ShipThreadMode) => void
  /** True while a ship is in flight; the whole control is disabled. */
  pending?: boolean
  /**
   * Set when we already know the project folder has uncommitted changes, which
   * makes "Merge and push" refuse server-side. Disables it up front instead.
   */
  projectFolderDirty?: boolean
  /** Raw daemon failure rendered in the dedicated merge-recovery dialog. */
  mergeFailure?: string | null
  onDismissMergeFailure?: () => void
  className?: string
}

/**
 * Lands an isolated thread's branch: the split button in the session header.
 * Hidden for same-folder threads, which have no branch of their own to land.
 */
export const ShipMenu = memo(function ShipMenu({
  thread,
  onShip,
  pending = false,
  projectFolderDirty = false,
  mergeFailure = null,
  onDismissMergeFailure,
  className,
}: ShipMenuProps) {
  const [open, setOpen] = useState(false)
  const variant = thread?.variant ?? null

  if (!variant) return null

  const isDisabled = (mode: ShipThreadMode) => pending || (mode === 'merge' && projectFolderDirty)

  const hintFor = (action: ShipAction) =>
    action.mode === 'merge' && projectFolderDirty
      ? 'Your project folder has uncommitted changes'
      : action.hint

  // Radix Popover handles dismissal and focus return; the `menu` role promises
  // arrow-key movement to assistive tech, so that part is wired up by hand.
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
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'),
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

  const baseBranch = variant.base_branch ?? 'the base branch'

  return (
    <div className={cn('flex shrink-0 items-center', className)}>
      <button
        type="button"
        disabled={pending}
        onClick={() => onShip(DEFAULT_MODE)}
        title={`Open a pull request from ${variant.branch} into ${baseBranch}`}
        className={cn(
          'fd-focus inline-flex h-7 items-center gap-1.5 rounded-l-[var(--fd-radius-md)] bg-accent px-2.5',
          'text-[length:var(--fd-text-xs)] font-medium text-surface-0 shadow-[var(--fd-shadow-sm)]',
          'transition-colors duration-[var(--fd-duration-fast)] hover:bg-accent-strong',
          'disabled:pointer-events-none disabled:opacity-40',
        )}
      >
        {pending ? (
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <GitMerge aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        Merge
      </button>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={pending}
            aria-label="Merge options"
            title="Merge options"
            className={cn(
              'fd-focus inline-flex h-7 items-center rounded-r-[var(--fd-radius-md)] bg-accent px-1.5',
              'border-l border-surface-0/20 text-surface-0 shadow-[var(--fd-shadow-sm)]',
              'transition-colors duration-[var(--fd-duration-fast)] hover:bg-accent-strong',
              'disabled:pointer-events-none disabled:opacity-40',
              open && 'bg-accent-strong',
            )}
          >
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={4}
            className="z-50 w-64 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
          >
            <div role="menu" aria-label="Land this isolated copy" onKeyDown={handleMenuKeyDown}>
              <p className="px-2.5 pb-1 pt-1.5 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
                {variant.branch}
              </p>
              {ACTIONS.map((action) => {
                const Icon = action.icon
                const disabled = isDisabled(action.mode)
                return (
                  <button
                    key={action.mode}
                    type="button"
                    role="menuitem"
                    disabled={disabled}
                    onClick={() => {
                      setOpen(false)
                      onShip(action.mode)
                    }}
                    className={cn(
                      'fd-focus-fill flex w-full items-start gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left',
                      'hover:bg-surface-3 focus-visible:bg-surface-3',
                      disabled && 'pointer-events-none opacity-40',
                    )}
                  >
                    <Icon
                      aria-hidden="true"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-secondary"
                    />
                    <span className="min-w-0">
                      <span className="block text-[length:var(--fd-text-sm)] text-fg-primary">
                        {action.label}
                      </span>
                      <span className="block text-[length:var(--fd-text-xs)] text-fg-muted">
                        {hintFor(action)}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {mergeFailure && onDismissMergeFailure ? (
        <MergeFailureDialog
          message={mergeFailure}
          branch={variant.branch}
          baseBranch={baseBranch}
          onDismiss={onDismissMergeFailure}
        />
      ) : null}
    </div>
  )
})
