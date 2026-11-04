import { useState, type ReactNode } from 'react'
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, cn } from '@falcondeck/ui'

import { ALL, count, type FilterOption } from './analytics-utils'

/** The one pattern for anything that can grow: this tall at most, with the
 * header stuck to the top of an internal scroll, and long lists cut to the
 * first ROW_LIMIT until asked for the rest. */
export const BOX = 'max-h-[24rem] overflow-auto'
const ROW_LIMIT = 25

export const TH =
  'sticky top-0 z-10 whitespace-nowrap bg-surface-1 px-3 pb-2 text-left text-[length:var(--fd-text-xs)] font-medium text-fg-muted shadow-[inset_0_-1px_0_var(--color-border-subtle)] first:pl-0 last:pr-0'
export const TD = 'border-t border-border-subtle px-3 py-2 align-top text-fg-secondary first:pl-0 last:pr-0'
export const NUM = 'whitespace-nowrap text-right tabular-nums'
export const NOTE = 'text-[length:var(--fd-text-sm)] text-fg-muted'
/** Fits every Settings width without viewport breakpoints. */
export const TILES = 'grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2.5'

export function Stat({ label, value, detail, wordy }: { label: string; value: string; detail?: string; wordy?: boolean }) {
  return (
    <div className="min-w-0 space-y-1 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-3.5 py-3">
      <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">{label}</p>
      <p
        className={cn(
          'truncate text-fg-primary tabular-nums',
          wordy ? 'py-0.5 text-[length:var(--fd-text-lg)] font-semibold tracking-tight' : 'fd-type-heading',
        )}
        title={value}
      >
        {value}
      </p>
      {detail ? <p className="truncate text-[length:var(--fd-text-xs)] text-fg-tertiary" title={detail}>{detail}</p> : null}
    </div>
  )
}

export function BoundedTable<Row>({
  label,
  head,
  rows,
  row,
  minWidth,
  total,
}: {
  /** Accessible name for the scrolling region. */
  label: string
  head: ReactNode
  rows: Row[]
  row: (row: Row) => ReactNode
  /** Tailwind min-width; below it the table scrolls sideways inside the box. */
  minWidth?: string
  /** Rows before filtering, when that differs from `rows`. */
  total?: number
}) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? rows : rows.slice(0, ROW_LIMIT)
  const hidden = rows.length - visible.length
  return (
    <div className="space-y-2">
      <div className={BOX} role="region" aria-label={label} tabIndex={0}>
        <table className={cn('w-full text-[length:var(--fd-text-sm)]', minWidth)}>
          <thead>
            <tr>{head}</tr>
          </thead>
          <tbody>{visible.map(row)}</tbody>
        </table>
      </div>
      {hidden > 0 || rows.length > ROW_LIMIT || (total !== undefined && total !== rows.length) ? (
        <div className="flex items-center justify-between gap-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <span className="tabular-nums">
            Showing {count(visible.length)} of {count(total ?? rows.length)}
          </span>
          {rows.length > ROW_LIMIT ? (
            <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? `Show top ${ROW_LIMIT}` : `Show all ${count(rows.length)}`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function AgentChip({ label, quiet }: { label: string; quiet?: boolean }) {
  return <Badge className={cn('whitespace-nowrap font-normal', quiet ? 'text-fg-muted' : null)}>{label}</Badge>
}

/** Menu filter over distinct values; pointless with one option, so it hides. */
export function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string
  allLabel: string
  value: string
  options: FilterOption[]
  onChange: (value: string) => void
}) {
  if (options.length < 2 && value === ALL) return null
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="max-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function FilterToggle({ label, active, onChange }: { label: string; active: boolean; onChange: (active: boolean) => void }) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={active}
      onClick={() => onChange(!active)}
      className={active ? 'text-fg-primary' : 'text-fg-muted'}
    >
      {label}
    </Button>
  )
}

export function FilterEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <p className={NOTE}>Nothing matches these filters.</p>
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  )
}

/** First load, before there is anything to show. */
export function LoadingTab() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading analytics">
      <div className={TILES}>
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-20 rounded-[var(--fd-radius-lg)]" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-[var(--fd-radius-lg)]" />
    </div>
  )
}
