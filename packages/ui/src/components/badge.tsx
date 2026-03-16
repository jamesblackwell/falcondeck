import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-[var(--fd-radius-full)] px-2.5 py-0.5 text-[length:var(--fd-text-xs)] font-medium',
  {
    variants: {
      variant: {
        default: 'bg-surface-3 text-fg-secondary',
        success: 'bg-success-muted text-success',
        warning: 'bg-warning-muted text-warning',
        danger: 'bg-danger-muted text-danger',
        info: 'bg-info-muted text-info',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean
}

export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, className }))} {...props}>
      {dot ? (
        <span
          className={cn('inline-block h-1.5 w-1.5 rounded-full', {
            'bg-fg-tertiary': variant === 'default',
            'bg-success': variant === 'success',
            'bg-warning': variant === 'warning',
            'bg-danger': variant === 'danger',
            'bg-info': variant === 'info',
          })}
        />
      ) : null}
      {children}
    </div>
  )
}
