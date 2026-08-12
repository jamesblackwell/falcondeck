import * as React from 'react'

import { cn } from '../lib/utils'

/**
 * Keeps `children` mounted for `durationMs` after `open` flips to false so an
 * exit transition can run. Reduced-motion users get the same timing on the
 * mount bookkeeping — the CSS transitions themselves are zeroed by the
 * duration tokens, so the region simply disappears a frame later.
 */
export function usePresence(open: boolean, durationMs: number) {
  const [mounted, setMounted] = React.useState(open)
  // Entering starts at the closed styles so the first painted frame animates.
  const [entered, setEntered] = React.useState(open)

  React.useEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setEntered(true))
      return () => cancelAnimationFrame(frame)
    }
    setEntered(false)
    const timer = setTimeout(() => setMounted(false), durationMs)
    return () => clearTimeout(timer)
  }, [open, durationMs])

  return { mounted, entered: entered && open }
}

/**
 * Remembers the last non-nullish value so a region can keep rendering its
 * content while it collapses away.
 */
export function useLastPresent<T>(value: T | null | undefined): T | null {
  const last = React.useRef<T | null>(value ?? null)
  if (value != null) last.current = value
  return last.current
}

const EXIT_MS = 180

/**
 * A horizontal bar that grows/shrinks in place. Uses the grid `0fr → 1fr`
 * trick so the region animates to its natural height without measuring.
 */
export function CollapseRegion({
  open,
  children,
  className,
}: {
  open: boolean
  children: React.ReactNode
  className?: string
}) {
  const { mounted, entered } = usePresence(open, EXIT_MS)
  if (!mounted) return null

  return (
    <div
      data-state={entered ? 'open' : 'closed'}
      className={cn(
        'grid shrink-0 grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-[var(--fd-duration-normal)] ease-[var(--fd-ease-default)]',
        'data-[state=open]:grid-rows-[1fr] data-[state=open]:opacity-100',
        className,
      )}
      // Only inert on the way out: entering regions often autofocus a control
      // on the same frame, and inert would swallow that focus.
      inert={!open ? true : undefined}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
