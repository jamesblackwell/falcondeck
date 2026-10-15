import { useMemo, useState } from 'react'
import { cn, SearchField } from '@falcondeck/ui'
import { ArrowLeft } from 'lucide-react'

import type { SettingsNavItem, SettingsSectionId } from './settings-utils'
import { SETTINGS_GROUPS, SETTINGS_SEARCH_INPUT_ID, searchSettings } from './settings-utils'

type SettingsSidebarProps = {
  activeSection: SettingsSectionId
  /** `setting` is an on-page title to scroll to after the page opens. */
  onSelectSection: (section: SettingsSectionId, setting?: string) => void
  onClose: () => void
}

export function SettingsSidebar({
  activeSection,
  onSelectSection,
  onClose,
}: SettingsSidebarProps) {
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchSettings(query), [query])
  const searching = query.trim().length > 0

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border-subtle bg-[color-mix(in_oklab,var(--color-surface-1)_96%,black)]">
      <div data-tauri-drag-region="deep" className="space-y-3 px-3 pb-3 pt-11">
        <button
          type="button"
          onClick={onClose}
          className="fd-focus flex items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-[length:var(--fd-text-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </button>
        <SearchField
          id={SETTINGS_SEARCH_INPUT_ID}
          label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault()
              event.stopPropagation()
              setQuery('')
            } else if (event.key === 'Enter' && results[0]) {
              event.preventDefault()
              onSelectSection(results[0].item.id, results[0].matches[0])
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {searching ? (
          <nav aria-label="Settings search results" className="space-y-1">
            {results.length === 0 ? (
              <p className="px-2 py-3 text-[length:var(--fd-text-sm)] text-fg-muted">
                No settings match “{query.trim()}”.
              </p>
            ) : (
              results.map(({ item, matches }) => (
                <div key={item.id}>
                  <NavButton
                    item={item}
                    isActive={item.id === activeSection}
                    showDescription={matches.length === 0}
                    onClick={() => onSelectSection(item.id)}
                  />
                  {matches.length > 0 ? (
                    <ul className="mb-1 ml-[1.375rem] border-l border-border-subtle pl-2">
                      {matches.map((setting) => (
                        <li key={setting}>
                          <button
                            type="button"
                            onClick={() => onSelectSection(item.id, setting)}
                            className="fd-focus w-full truncate rounded-[var(--fd-radius-md)] px-2 py-1 text-left text-[length:var(--fd-text-xs)] text-fg-tertiary transition-colors hover:bg-surface-2 hover:text-fg-primary"
                          >
                            {setting}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))
            )}
          </nav>
        ) : (
          <nav aria-label="Settings" className="space-y-4">
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.label} className="space-y-0.5">
                <p className="px-2 pb-1 text-[length:var(--fd-text-xs)] font-medium text-fg-muted">
                  {group.label}
                </p>
                {group.items.map((item) => (
                  <NavButton
                    key={item.id}
                    item={item}
                    isActive={item.id === activeSection}
                    onClick={() => onSelectSection(item.id)}
                  />
                ))}
              </div>
            ))}
          </nav>
        )}
      </div>
    </aside>
  )
}

function NavButton({
  item,
  isActive,
  showDescription = false,
  onClick,
}: {
  item: SettingsNavItem
  isActive: boolean
  showDescription?: boolean
  onClick: () => void
}) {
  const Icon = item.icon
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? 'page' : undefined}
      title={showDescription ? undefined : item.description}
      className={cn(
        'fd-focus flex w-full items-start gap-2.5 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left transition-colors',
        isActive
          ? 'bg-surface-3 text-fg-primary'
          : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-[length:var(--fd-text-sm)] font-medium">{item.label}</span>
        {showDescription ? (
          <span className="block text-[length:var(--fd-text-xs)] text-fg-muted">
            {item.description}
          </span>
        ) : null}
      </span>
    </button>
  )
}
