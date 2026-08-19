import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { Kbd } from './kbd'
import { cn } from '../lib/utils'

const TooltipScopeContext = React.createContext(false)

/**
 * Shared delay so moving between nearby controls does not restart the wait.
 * Individual `Tooltip` trees fall back to their own provider when a host has
 * not wrapped the tree — tests and compact surfaces stay self-contained.
 */
export function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 200,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipScopeContext.Provider value={true}>
      <TooltipPrimitive.Provider
        delayDuration={delayDuration}
        skipDelayDuration={skipDelayDuration}
        disableHoverableContent
        {...props}
      >
        {children}
      </TooltipPrimitive.Provider>
    </TooltipScopeContext.Provider>
  )
}

export type TooltipProps = {
  children: React.ReactElement
  /** Short name shown to the left of any keycaps. */
  label: string
  /** Binding tokens ("⌘", "↵"), one keycap each. */
  shortcut?: readonly string[]
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>['side']
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>['align']
}

function TooltipTree({
  children,
  label,
  shortcut,
  side = 'top',
  align = 'center',
}: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'fd-menu-pop z-50 flex items-center gap-1.5 rounded-[var(--fd-radius-md)]',
            'border border-border-default bg-surface-3 px-2.5 py-1',
            'text-[length:var(--fd-text-xs)] font-medium text-fg-primary',
            'shadow-[var(--fd-shadow-lg)]',
          )}
        >
          <span>{label}</span>
          {shortcut?.length ? (
            <span aria-hidden="true" className="flex items-center gap-0.5">
              {shortcut.map((token, index) => (
                <Kbd
                  key={`${token}-${index}`}
                  className="h-4 min-w-4 justify-center border-border-subtle bg-surface-1 px-1 py-0 font-sans text-fg-secondary"
                >
                  {token}
                </Kbd>
              ))}
            </span>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

/**
 * Hover/focus label with optional keyboard keycaps. Prefer this over `title`
 * on icon buttons so the hint matches the rest of the chrome instead of the
 * native OS tooltip.
 */
export function Tooltip(props: TooltipProps) {
  const scoped = React.useContext(TooltipScopeContext)
  const tree = <TooltipTree {...props} />
  if (scoped) return tree
  return <TooltipProvider>{tree}</TooltipProvider>
}
