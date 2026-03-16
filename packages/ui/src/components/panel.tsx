import * as React from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronDown } from 'lucide-react'

import { cn } from '../lib/utils'

export type PanelProps = {
  children: React.ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

export function Panel({
  children,
  collapsible = false,
  defaultOpen = true,
  open,
  onOpenChange,
  className,
}: PanelProps) {
  if (!collapsible) {
    return <div className={cn('border-t border-border-subtle', className)}>{children}</div>
  }

  return (
    <Collapsible.Root
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      className={cn('border-t border-border-subtle', className)}
    >
      {children}
    </Collapsible.Root>
  )
}

export function PanelHeader({
  className,
  children,
  collapsible = false,
  ...props
}: React.HTMLAttributes<HTMLElement> & { collapsible?: boolean }) {
  if (collapsible) {
    return (
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left',
            className,
          )}
          {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        >
          <span className="flex items-center gap-2 text-[length:var(--fd-text-sm)] font-medium text-fg-secondary">
            {children}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3.5 text-fg-muted transition-transform duration-[var(--fd-duration-normal)] [[data-state=closed]_&]:rotate-[-90deg]"
          />
        </button>
      </Collapsible.Trigger>
    )
  }

  return (
    <div className={cn('flex items-center justify-between px-4 py-3', className)} {...props}>
      <div className="flex items-center gap-2 text-[length:var(--fd-text-sm)] font-medium text-fg-secondary">
        {children}
      </div>
    </div>
  )
}

export function PanelContent({
  className,
  children,
  collapsible = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { collapsible?: boolean }) {
  const inner = (
    <div className={cn('px-4 pb-4', className)} {...props}>
      {children}
    </div>
  )

  if (collapsible) {
    return (
      <Collapsible.Content className="overflow-hidden data-[state=closed]:animate-collapse data-[state=open]:animate-expand">
        {inner}
      </Collapsible.Content>
    )
  }

  return inner
}
