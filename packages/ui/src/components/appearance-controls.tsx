import { Monitor, Moon, Sun } from 'lucide-react'

import {
  FONT_SCALE_OPTIONS,
  MONO_FONT_OPTIONS,
  PALETTE_OPTIONS,
  SANS_FONT_OPTIONS,
  THEME_OPTIONS,
  resolveTheme,
  updateAppearance,
  useAppearance,
  type PalettePreview,
  type ThemeSetting,
} from '../lib/appearance'
import { cn } from '../lib/utils'

const THEME_ICONS: Record<ThemeSetting, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

function optionClass(selected: boolean) {
  return cn(
    'fd-focus rounded-[var(--fd-radius-lg)] border p-3 text-left transition-colors',
    selected
      ? 'border-accent/50 bg-accent/10'
      : 'border-border-subtle bg-surface-2 hover:bg-surface-3',
  )
}

function GroupLabel({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">{title}</p>
      <p className="mt-0.5 text-[length:var(--fd-text-xs)] text-fg-tertiary">{hint}</p>
    </div>
  )
}

function PaletteSwatch({ preview }: { preview: PalettePreview }) {
  return (
    <div
      aria-hidden
      className="flex h-10 w-full items-center justify-center gap-1.5 rounded-[var(--fd-radius-md)] border border-border-subtle"
      style={{ backgroundColor: preview.bg }}
    >
      <span
        className="h-4 w-4 rounded-full"
        style={{ backgroundColor: preview.accent }}
      />
      <span
        className="h-4 w-9 rounded-[4px]"
        style={{ backgroundColor: preview.surface, border: `1px solid ${preview.fg}22` }}
      />
      <span
        className="h-4 w-4 rounded-[4px]"
        style={{ backgroundColor: preview.fg, opacity: 0.85 }}
      />
    </div>
  )
}

/**
 * Theme, font, and text-size pickers backed by the shared appearance store.
 * Presentation-free at the edges so both the desktop settings page and the
 * remote web preferences modal can embed it.
 */
export function AppearanceControls() {
  const appearance = useAppearance()
  const resolvedTheme = resolveTheme(appearance.theme)

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <GroupLabel title="Theme" hint="System follows this device’s light or dark appearance." />
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((option) => {
            const Icon = THEME_ICONS[option.value]
            const selected = appearance.theme === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => updateAppearance({ theme: option.value })}
                className={cn(optionClass(selected), 'flex flex-col items-center gap-1.5 py-3')}
              >
                <Icon className={cn('h-4 w-4', selected ? 'text-accent' : 'text-fg-tertiary')} />
                <span className="text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
                  {option.label}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <GroupLabel
          title="Color theme"
          hint="Every palette ships light and dark variants, so it composes with the theme above."
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {PALETTE_OPTIONS.map((option) => {
            const selected = appearance.palette === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => updateAppearance({ palette: option.value })}
                className={cn(optionClass(selected), 'space-y-2')}
              >
                <PaletteSwatch preview={option.preview[resolvedTheme]} />
                <span className="block text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
                  {option.label}
                </span>
                <span className="block text-[length:var(--fd-text-2xs)] leading-snug text-fg-tertiary">
                  {option.description}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <GroupLabel title="Interface font" hint="Used for all app text outside of code." />
        <div className="grid grid-cols-3 gap-2">
          {SANS_FONT_OPTIONS.map((option) => {
            const selected = appearance.sansFont === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => updateAppearance({ sansFont: option.value })}
                className={cn(optionClass(selected), 'flex flex-col items-center gap-1 py-3')}
              >
                <span
                  aria-hidden
                  className="text-[length:var(--fd-text-lg)] leading-none text-fg-primary"
                  style={{ fontFamily: option.stack }}
                >
                  Ag
                </span>
                <span className="text-[length:var(--fd-text-xs)] text-fg-secondary">
                  {option.label}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <GroupLabel title="Code font" hint="Used for terminal output, diffs, and code blocks." />
        <div className="grid grid-cols-2 gap-2">
          {MONO_FONT_OPTIONS.map((option) => {
            const selected = appearance.monoFont === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => updateAppearance({ monoFont: option.value })}
                className={cn(optionClass(selected), 'flex flex-col items-center gap-1 py-3')}
              >
                <span
                  aria-hidden
                  className="text-[length:var(--fd-text-base)] leading-none text-fg-primary"
                  style={{ fontFamily: option.stack }}
                >
                  {'{ }'}
                </span>
                <span className="text-[length:var(--fd-text-xs)] text-fg-secondary">
                  {option.label}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <GroupLabel title="Text size" hint="Scales all interface text." />
        <div className="grid grid-cols-4 gap-2">
          {FONT_SCALE_OPTIONS.map((option) => {
            const selected = appearance.fontScale === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => updateAppearance({ fontScale: option.value })}
                className={cn(optionClass(selected), 'flex flex-col items-center gap-1 py-3')}
              >
                <span
                  aria-hidden
                  className="leading-none text-fg-primary"
                  style={{ fontSize: `${15 * option.value}px` }}
                >
                  Aa
                </span>
                <span className="text-[length:var(--fd-text-2xs)] text-fg-secondary">
                  {option.label}
                </span>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
