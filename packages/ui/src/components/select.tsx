import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'

import { cn } from '../lib/utils'

export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value

/**
 * `quiet` drops the chip treatment down to label-plus-chevron text, for rows of
 * toggles that should read as a sentence rather than a row of buttons.
 */
export type SelectTriggerVariant = 'default' | 'quiet'

const SELECT_TRIGGER_VARIANTS: Record<SelectTriggerVariant, string> = {
  default:
    'h-8 justify-between gap-1.5 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-3 px-2.5 text-fg-secondary hover:bg-surface-4 data-[state=open]:border-border-emphasis',
  quiet:
    'h-7 gap-1 rounded-[var(--fd-radius-md)] px-1.5 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary data-[state=open]:bg-surface-3 data-[state=open]:text-fg-secondary',
}

export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
    variant?: SelectTriggerVariant
  }
>(({ className, children, variant = 'default', ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'fd-focus inline-flex max-w-full items-center text-[length:var(--fd-text-xs)] transition-colors duration-[var(--fd-duration-fast)] disabled:cursor-not-allowed disabled:opacity-50',
      SELECT_TRIGGER_VARIANTS[variant],
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-3 w-3 shrink-0 text-fg-muted" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', sideOffset = 6, collisionPadding = 8, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        'z-50 overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-emphasis bg-surface-2 text-fg-primary shadow-[var(--fd-shadow-lg)]',
        className,
      )}
      {...props}
    >
      {/* Popper positioning with a natively scrolling viewport. Radix's default
          "item-aligned" mode overlays the trigger and repositions the popup on
          every wheel tick, which flickers on trackpads — same reason there are
          no ScrollUp/DownButtons: they mount into the flow the moment the list
          can scroll, shoving every row down a step. */}
      <SelectPrimitive.Viewport className="max-h-[min(18rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] p-1.5">
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = SelectPrimitive.Content.displayName

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center rounded-[var(--fd-radius-md)] py-1.5 pl-3 pr-8 text-[length:var(--fd-text-sm)] text-fg-secondary outline-none transition-colors focus:bg-surface-3 focus:text-fg-primary',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="absolute right-3 inline-flex items-center">
      <Check className="h-3.5 w-3.5 text-accent" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
))
SelectItem.displayName = SelectPrimitive.Item.displayName
