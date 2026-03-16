import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../lib/utils'

const cardVariants = cva('border backdrop-blur-sm', {
  variants: {
    variant: {
      elevated:
        'rounded-[var(--fd-radius-xl)] border-border-default bg-surface-2 shadow-[var(--fd-shadow-lg)]',
      flat: 'rounded-[var(--fd-radius-xl)] border-border-default bg-surface-1',
      ghost: 'rounded-[var(--fd-radius-xl)] border-transparent bg-transparent',
    },
  },
  defaultVariants: {
    variant: 'flat',
  },
})

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export function Card({ className, variant, ...props }: CardProps) {
  return <div className={cn(cardVariants({ variant, className }))} {...props} />
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-2 p-5 pb-3', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('text-[length:var(--fd-text-lg)] font-semibold tracking-tight text-fg-primary', className)}
      {...props}
    />
  )
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-[length:var(--fd-text-sm)] text-fg-tertiary', className)} {...props} />
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />
}
