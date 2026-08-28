import * as React from 'react'
import { memo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import {
  Check,
  ChevronRight,
  Gauge,
  Keyboard,
  Mic,
  Palette,
  RefreshCw,
  Settings,
  SlidersHorizontal,
} from 'lucide-react'

import {
  Kbd,
  cn,
  updateAppearance,
  useAppearance,
  type ThemeSetting,
} from '@falcondeck/ui'

import {
  shortcutHintTokens,
  useShortcutSettings,
} from '../shortcuts'
import {
  useDictationSettings,
  writeDictationSettings,
  type DictationActivation,
  type DictationProvider,
} from '../dictation'

export type SidebarOptionsMenuProps = {
  onOpenSettings?: () => void
  settingsOpen?: boolean
  onOpenUsage?: () => void
  onOpenKeyboardShortcuts?: () => void
  onOpenSpeechSettings?: () => void
  onCheckForUpdates?: () => void
}

type Submenu = 'theme' | 'speech'

const THEMES: Array<{ id: ThemeSetting; label: string }> = [
  { id: 'system', label: 'System default' },
  { id: 'dark', label: 'Dark theme' },
  { id: 'light', label: 'Light theme' },
]

const ACTIVATIONS: Array<{ id: DictationActivation; label: string }> = [
  { id: 'hold', label: 'Hold to dictate' },
  { id: 'toggle', label: 'Press to toggle' },
]

const ENGINES: Array<{ id: DictationProvider; label: string }> = [
  { id: 'system', label: 'Apple Speech' },
  { id: 'open_router', label: 'Cloud model' },
]

const SUBMENU_ITEM_CLASS =
  'fd-focus flex w-full items-center justify-between gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3'

export const SidebarOptionsMenu = memo(function SidebarOptionsMenu({
  onOpenSettings,
  settingsOpen = false,
  onOpenUsage,
  onOpenKeyboardShortcuts,
  onOpenSpeechSettings,
  onCheckForUpdates,
}: SidebarOptionsMenuProps) {
  const [open, setOpen] = useState(false)
  const [openSubmenu, setOpenSubmenu] = useState<Submenu | null>(null)
  const appearance = useAppearance()
  const shortcutSettings = useShortcutSettings()
  const dictation = useDictationSettings()
  const submenuTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // shortcutHintTokens is undefined for an unbound command; the render sites
  // already treat a missing hint as "show no Kbd".
  const settingsShortcut = shortcutHintTokens('openSettings', shortcutSettings)?.join('')
  const shortcutsShortcut = shortcutHintTokens('openKeyboardShortcuts', shortcutSettings)?.join('')
  const usageShortcut = shortcutHintTokens('openUsage', shortcutSettings)?.join('')

  const handleOpenSubmenu = (submenu: Submenu) => {
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current)
      submenuTimeoutRef.current = null
    }
    setOpenSubmenu(submenu)
  }

  const handleCloseSubmenu = () => {
    submenuTimeoutRef.current = setTimeout(() => {
      setOpenSubmenu(null)
    }, 150)
  }

  const handleSelectTheme = (theme: ThemeSetting) => {
    updateAppearance({ theme })
    setOpen(false)
    setOpenSubmenu(null)
  }

  // Quick dictation settings stay open: they are the kind of thing you flip
  // and immediately check, and reopening the menu for each one is a chore.
  const updateDictation = (patch: Partial<typeof dictation>) => {
    writeDictationSettings({ ...dictation, ...patch })
  }

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"], :scope > div > [role="menuitem"]'),
    )
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setOpenSubmenu(null)
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Options"
          className={cn(
            'fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors',
            open || settingsOpen
              ? 'bg-surface-3 text-fg-primary'
              : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
          )}
        >
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">Options</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 w-60 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)] outline-none"
        >
          <div
            role="menu"
            aria-label="Options menu"
            onKeyDown={handleMenuKeyDown}
            className="flex flex-col gap-0.5"
          >
            {onOpenUsage ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onOpenUsage()
                }}
                className="fd-focus flex w-full items-center justify-between gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Gauge aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
                  <span>Usage</span>
                </div>
                {usageShortcut ? <Kbd>{usageShortcut}</Kbd> : null}
              </button>
            ) : null}

            <div
              className="relative"
              onMouseEnter={() => handleOpenSubmenu('theme')}
              onMouseLeave={handleCloseSubmenu}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openSubmenu === 'theme'}
                onClick={() =>
                  setOpenSubmenu((prev) => (prev === 'theme' ? null : 'theme'))
                }
                className={cn(
                  'fd-focus flex w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] transition-colors',
                  openSubmenu === 'theme'
                    ? 'bg-surface-3 text-fg-primary'
                    : 'text-fg-primary hover:bg-surface-3',
                )}
              >
                <Palette aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
                <span className="flex-1">App theme</span>
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
              </button>

              {openSubmenu === 'theme' ? (
                <div
                  role="menu"
                  aria-label="App theme options"
                  className="absolute left-full top-0 ml-1.5 w-44 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
                >
                  {THEMES.map((theme) => {
                    const isSelected = appearance.theme === theme.id
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => handleSelectTheme(theme.id)}
                        className="fd-focus flex w-full items-center justify-between rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3"
                      >
                        <span>{theme.label}</span>
                        {isSelected ? (
                          <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>

            <div
              className="relative"
              onMouseEnter={() => handleOpenSubmenu('speech')}
              onMouseLeave={handleCloseSubmenu}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openSubmenu === 'speech'}
                onClick={() =>
                  setOpenSubmenu((prev) => (prev === 'speech' ? null : 'speech'))
                }
                className={cn(
                  'fd-focus flex w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] transition-colors',
                  openSubmenu === 'speech'
                    ? 'bg-surface-3 text-fg-primary'
                    : 'text-fg-primary hover:bg-surface-3',
                )}
              >
                <Mic aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
                <span className="flex-1">Dictation</span>
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
              </button>

              {openSubmenu === 'speech' ? (
                <div
                  role="menu"
                  aria-label="Dictation options"
                  className="absolute left-full top-0 ml-1.5 w-52 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
                >
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={dictation.enabled}
                    onClick={() => updateDictation({ enabled: !dictation.enabled })}
                    className={SUBMENU_ITEM_CLASS}
                  >
                    <span>System-wide dictation</span>
                    {dictation.enabled ? (
                      <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                    ) : null}
                  </button>

                  <div className="my-1 border-t border-border-subtle" role="separator" />
                  {ACTIVATIONS.map((activation) => (
                    <button
                      key={activation.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={dictation.activation === activation.id}
                      onClick={() => updateDictation({ activation: activation.id })}
                      className={SUBMENU_ITEM_CLASS}
                    >
                      <span>{activation.label}</span>
                      {dictation.activation === activation.id ? (
                        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                      ) : null}
                    </button>
                  ))}

                  <div className="my-1 border-t border-border-subtle" role="separator" />
                  {ENGINES.map((engine) => (
                    <button
                      key={engine.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={dictation.provider === engine.id}
                      onClick={() => updateDictation({ provider: engine.id })}
                      className={SUBMENU_ITEM_CLASS}
                    >
                      <span>{engine.label}</span>
                      {dictation.provider === engine.id ? (
                        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                      ) : null}
                    </button>
                  ))}

                  {onOpenSpeechSettings ? (
                    <>
                      <div className="my-1 border-t border-border-subtle" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpen(false)
                          setOpenSubmenu(null)
                          onOpenSpeechSettings()
                        }}
                        className={SUBMENU_ITEM_CLASS}
                      >
                        <span>Speech settings…</span>
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            {onOpenKeyboardShortcuts ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onOpenKeyboardShortcuts()
                }}
                className="fd-focus flex w-full items-center justify-between gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Keyboard aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
                  <span>Keyboard shortcuts</span>
                </div>
                {shortcutsShortcut ? <Kbd>{shortcutsShortcut}</Kbd> : null}
              </button>
            ) : null}

            {onCheckForUpdates ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onCheckForUpdates()
                }}
                className="fd-focus flex w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3"
              >
                <RefreshCw aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
                <span className="flex-1">Check for updates…</span>
              </button>
            ) : null}

            {onOpenSettings ? (
              <>
                <div className="my-1 border-t border-border-subtle" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    onOpenSettings()
                  }}
                  className="fd-focus flex w-full items-center justify-between gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Settings aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
                    <span>Settings</span>
                  </div>
                  {settingsShortcut ? <Kbd>{settingsShortcut}</Kbd> : null}
                </button>
              </>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
})
