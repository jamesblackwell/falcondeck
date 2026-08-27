import * as React from 'react'

import { cn } from '../lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card'

/* Shared building blocks for the settings surfaces.
 *
 * The hierarchy every panel follows, loudest to quietest:
 *   page title -> section title -> field label -> control -> hint.
 * Sections are cards, fields inside a section are separated by hairlines
 * instead of nested boxes, and hints are always the smallest, dimmest text. */

export function SettingsPage({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('space-y-6 pb-12', className)} {...props} />
}

export function SettingsPageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-start justify-between gap-4 border-b border-border-subtle pb-5',
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold tracking-tight text-fg-primary">
          {title}
        </h1>
        {description ? (
          <p className="max-w-[60ch] text-[length:var(--fd-text-sm)] text-fg-tertiary">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="gap-1.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <CardTitle>{title}</CardTitle>
            {description ? (
              <CardDescription className="max-w-[62ch]">{description}</CardDescription>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      </CardHeader>
      {children ? (
        <CardContent className={cn('space-y-5', contentClassName)}>{children}</CardContent>
      ) : null}
    </Card>
  )
}

/** Hairline-separated stack of rows. Bleeds to the card edges so the
 * separators read as structure rather than as another nested container. */
export function SettingList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('-mx-5 divide-y divide-border-subtle border-y border-border-subtle', className)}
      {...props}
    />
  )
}

export function SettingRow({
  title,
  description,
  control,
  onActivate,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  control?: React.ReactNode
  /** Makes the whole row the hit target for its control. */
  onActivate?: () => void
  className?: string
}) {
  return (
    // The row is a convenience hit target only — `control` stays the single
    // focusable, keyboard-operable element, so this must not be a <button>.
    <div
      onClick={onActivate}
      className={cn(
        'flex w-full items-start justify-between gap-4 px-5 py-3.5 text-left',
        onActivate ? 'cursor-pointer transition-colors hover:bg-surface-2' : null,
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">{title}</p>
        {description ? (
          <p className="max-w-[62ch] text-[length:var(--fd-text-xs)] leading-relaxed text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      {control ? <div className="shrink-0 pt-0.5">{control}</div> : null}
    </div>
  )
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  /** Accessible name when the switch is not wrapped by a visible label. */
  label?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onCheckedChange(!checked)
      }}
      className={cn(
        'fd-focus relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full border transition-colors duration-[var(--fd-duration-fast)] disabled:opacity-40',
        checked
          ? 'border-accent bg-accent'
          : 'border-border-emphasis bg-surface-4 hover:bg-surface-3',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block h-[14px] w-[14px] rounded-full transition-transform duration-[var(--fd-duration-fast)]',
          checked ? 'translate-x-[17px] bg-surface-0' : 'translate-x-[2px] bg-fg-muted',
        )}
      />
    </button>
  )
}

/** A row whose control is a switch; clicking anywhere in the row toggles it. */
export function SwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: string
  description?: React.ReactNode
  checked: boolean
  onCheckedChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <SettingRow
      title={title}
      description={description}
      onActivate={disabled ? undefined : () => onCheckedChange(!checked)}
      control={
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          label={title}
        />
      }
    />
  )
}

/** Label + control + hint, with the typography every panel should share. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {htmlFor ? (
        <label
          htmlFor={htmlFor}
          className="block text-[length:var(--fd-text-sm)] font-medium text-fg-secondary"
        >
          {label}
        </label>
      ) : (
        <span className="block text-[length:var(--fd-text-sm)] font-medium text-fg-secondary">
          {label}
        </span>
      )}
      {children}
      {hint ? (
        <p className="max-w-[62ch] text-[length:var(--fd-text-xs)] leading-relaxed text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  ariaLabel?: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'fd-focus rounded-[calc(var(--fd-radius-md)-2px)] px-3 py-1.5 text-[length:var(--fd-text-sm)] font-medium transition-colors duration-[var(--fd-duration-fast)]',
              selected
                ? 'bg-surface-3 text-fg-primary shadow-[var(--fd-shadow-sm)]'
                : 'text-fg-muted hover:text-fg-secondary',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Radio-style card for mutually exclusive choices that need a description. */
export function OptionCard({
  label,
  description,
  selected,
  onSelect,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  selected: boolean
  onSelect: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'fd-focus flex items-start gap-3 rounded-[var(--fd-radius-lg)] border p-3.5 text-left transition-colors duration-[var(--fd-duration-fast)]',
        selected
          ? 'border-accent/60 bg-accent-dim'
          : 'border-border-subtle bg-surface-1 hover:border-border-default hover:bg-surface-3/60',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
          selected ? 'border-accent bg-accent' : 'border-border-emphasis',
        )}
      >
        {selected ? <span className="h-1.5 w-1.5 rounded-full bg-surface-0" /> : null}
      </span>
      <span className="min-w-0 space-y-1">
        <span className="block text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
          {label}
        </span>
        {description ? (
          <span className="block text-[length:var(--fd-text-xs)] leading-relaxed text-fg-muted">
            {description}
          </span>
        ) : null}
      </span>
    </button>
  )
}
