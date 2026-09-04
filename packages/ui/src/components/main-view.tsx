import * as React from 'react'
import { X } from 'lucide-react'

import { cn } from '../lib/utils'
import { Button } from './button'

export type MainViewProps = {
  icon?: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
  onClose?: () => void
  closeLabel?: string
  /** Pad the chrome clear of macOS traffic lights in a detached window. */
  trafficLightInset?: boolean
  /** Accessible name for the chrome; defaults to `title` when it is a string. */
  headerAriaLabel?: string
  children: React.ReactNode
  className?: string
}

export function MainView({
  icon,
  title,
  meta,
  actions,
  onClose,
  closeLabel,
  trafficLightInset = false,
  headerAriaLabel,
  children,
  className,
}: MainViewProps) {
  const titleText = typeof title === 'string' ? title : undefined
  const headerLabel = headerAriaLabel ?? titleText
  const resolvedCloseLabel = closeLabel ?? (titleText ? `Close ${titleText}` : 'Close')

  return (
    <section
      aria-label={titleText}
      className={cn('flex h-full min-h-0 flex-col bg-surface-1 text-fg-primary', className)}
    >
      <header
        aria-label={headerLabel}
        data-tauri-drag-region="deep"
        className={cn(
          'flex min-h-14 shrink-0 items-center gap-3 border-b border-border-subtle px-5 py-2.5',
          trafficLightInset && 'pl-[86px]',
        )}
      >
        {icon ? <span className="shrink-0 text-fg-muted">{icon}</span> : null}
        <div className="min-w-0 flex-1">
          <h1 className="fd-type-heading fd-type-heading--sm truncate text-fg-primary">{title}</h1>
          {meta ? <p className="fd-type-meta truncate text-fg-muted">{meta}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        {onClose ? (
          <Button type="button" variant="ghost" size="icon" aria-label={resolvedCloseLabel} onClick={onClose}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        ) : null}
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </section>
  )
}

export type MainViewBodyProps = {
  /** Directory is a reading column. Workspace fills the frame. */
  layout?: 'directory' | 'workspace'
  className?: string
  children: React.ReactNode
}

export const MainViewBody = React.forwardRef<HTMLDivElement, MainViewBodyProps>(
  function MainViewBody({ layout = 'directory', className, children }, ref) {
    if (layout === 'workspace') {
      return (
        <div ref={ref} className={cn('min-h-0 flex-1 overflow-hidden', className)}>
          {children}
        </div>
      )
    }

    return (
      <div ref={ref} className={cn('min-h-0 flex-1 overflow-y-auto', className)}>
        <div className="mx-auto w-full max-w-4xl px-6 py-6">{children}</div>
      </div>
    )
  },
)

export function MainViewLead({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'max-w-[60ch] text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary',
        className,
      )}
      {...props}
    />
  )
}

export function MainViewSection({
  title,
  count,
  actions,
  children,
  className,
  contentClassName,
  ...props
}: {
  title: string
  count?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
  contentClassName?: string
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  const titleId = React.useId()
  return (
    <section aria-labelledby={titleId} className={className} {...props}>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 id={titleId} className="fd-type-eyebrow text-fg-muted">
          {title}
        </h2>
        {count != null && count !== '' ? (
          <span className="fd-type-meta text-fg-muted">{count}</span>
        ) : null}
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className={contentClassName}>{children}</div> : null}
    </section>
  )
}
