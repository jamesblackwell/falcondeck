import { cn } from '@falcondeck/ui'
import { ArrowLeft } from 'lucide-react'

import type { SettingsSectionId } from './settings-utils'
import { SETTINGS_NAV } from './settings-utils'

type SettingsSidebarProps = {
  activeSection: SettingsSectionId
  onSelectSection: (section: SettingsSectionId) => void
  onClose: () => void
}

export function SettingsSidebar({
  activeSection,
  onSelectSection,
  onClose,
}: SettingsSidebarProps) {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border-subtle bg-[color-mix(in_oklab,var(--color-surface-1)_96%,black)]">
      <div className="border-b border-border-subtle px-4 pb-4 pt-11">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-[length:var(--fd-text-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </button>
      </div>

      <div className="flex-1 px-3 py-4">
        <nav className="space-y-1">
          {SETTINGS_NAV.map((item) => {
            const Icon = item.icon
            const isActive = item.id === activeSection
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectSection(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex w-full items-start gap-3 rounded-[var(--fd-radius-lg)] px-3 py-2.5 text-left transition-colors',
                  isActive
                    ? 'bg-surface-3 text-fg-primary'
                    : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
                )}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-[length:var(--fd-text-sm)] font-medium">
                    {item.label}
                  </span>
                  <span className="mt-0.5 block text-[length:var(--fd-text-xs)] text-fg-muted">
                    {item.description}
                  </span>
                </span>
              </button>
            )
          })}
        </nav>
      </div>
    </aside>
  )
}
