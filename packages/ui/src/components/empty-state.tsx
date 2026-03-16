import * as React from 'react'

import { cn } from '../lib/utils'

export type EmptyStateProps = {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 py-12 text-center',
        className,
      )}
    >
      {icon ? <div className="mb-1 text-fg-muted">{icon}</div> : null}
      <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-tertiary">{title}</p>
      {description ? (
        <p className="max-w-[240px] text-[length:var(--fd-text-xs)] text-fg-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
