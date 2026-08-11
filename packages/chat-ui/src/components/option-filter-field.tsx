import { useId, type KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'

export function OptionFilterField({
  value,
  onChange,
  label,
  resultCount,
  autoFocus = false,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  resultCount: number
  autoFocus?: boolean
}) {
  const statusId = useId()
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keep printable keys out of Radix menu typeahead. Escape still bubbles so
    // the containing popover closes exactly like an unfiltered menu.
    if (event.key !== 'Escape') event.stopPropagation()
  }

  return (
    <div role="search" className="relative mx-1 mb-1">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted"
      />
      <input
        autoFocus={autoFocus}
        type="text"
        role="searchbox"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        aria-label={label}
        aria-describedby={statusId}
        placeholder="Search…"
        autoComplete="off"
        spellCheck={false}
        className="h-8 w-full rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 py-1 pl-8 pr-8 text-[length:var(--fd-text-sm)] text-fg-primary outline-none placeholder:text-fg-muted focus:border-border-emphasis"
      />
      {value ? (
        <button
          type="button"
          aria-label={`Clear ${label.toLocaleLowerCase()}`}
          onClick={() => onChange('')}
          className="fd-focus absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <span id={statusId} className="sr-only" aria-live="polite">
        {resultCount} {resultCount === 1 ? 'option' : 'options'}
      </span>
    </div>
  )
}
