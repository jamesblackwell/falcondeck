import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap text-[length:var(--fd-text-sm)] font-medium transition-all duration-[var(--fd-duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98]',
  {
    variants: {
      variant: {
        default:
          'bg-accent text-surface-0 shadow-[var(--fd-shadow-sm)] hover:bg-accent-strong',
        secondary: 'bg-surface-3 text-fg-primary hover:bg-surface-4',
        outline: 'border border-border-emphasis bg-transparent text-fg-primary hover:bg-surface-3',
        ghost: 'bg-transparent text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
        danger: 'bg-danger text-surface-0 hover:brightness-110',
      },
      size: {
        default: 'h-9 rounded-[var(--fd-radius-lg)] px-3.5',
        sm: 'h-7 rounded-[var(--fd-radius-md)] px-2.5 text-[length:var(--fd-text-xs)]',
        lg: 'h-11 rounded-[var(--fd-radius-xl)] px-5 text-[length:var(--fd-text-base)]',
        icon: 'h-8 w-8 rounded-[var(--fd-radius-md)]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
