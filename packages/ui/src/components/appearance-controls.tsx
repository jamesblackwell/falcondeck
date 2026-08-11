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
  type PaletteSetting,
  type PalettePreview,
  type ThemeSetting,
} from '../lib/appearance'
import { cn } from '../lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger } from './select'

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

/**
 * A palette's identity in one chip: the circle is quartered into canvas,
 * raised surface, text, and accent, so two schemes never look alike at 18px.
 * The ring is a translucent ink rather than a token border — the chip has to
 * stay readable against whichever surface it lands on.
 */
export function PaletteSwatch({
  preview,
  size = 18,
  className,
}: {
  preview: PalettePreview
  size?: number
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 rounded-full ring-1 ring-inset ring-fg-primary/20', className)}
      style={{
        width: size,
        height: size,
        // Quadrant order matches the 2x2 grid the mobile swatch paints:
        // canvas top-left, surface top-right, accent bottom-right, text bottom-left.
        background: `conic-gradient(from 0deg, ${preview.surface} 0deg 90deg, ${preview.accent} 90deg 180deg, ${preview.fg} 180deg 270deg, ${preview.bg} 270deg 360deg)`,
      }}
    />
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
  const activePalette =
    PALETTE_OPTIONS.find((option) => option.value === appearance.palette) ?? PALETTE_OPTIONS[0]

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
        <Select
          value={appearance.palette}
          onValueChange={(value) => updateAppearance({ palette: value as PaletteSetting })}
        >
          <SelectTrigger
            aria-label="Color theme"
            className="h-10 w-full justify-between gap-2 px-3 text-[length:var(--fd-text-sm)] text-fg-primary"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <PaletteSwatch preview={activePalette.preview[resolvedTheme]} />
              <span className="truncate">{activePalette.label}</span>
            </span>
          </SelectTrigger>
          {/* Two-line rows, so the default list height would only show five of
              nine palettes before scrolling. */}
          <SelectContent viewportClassName="max-h-[min(26rem,var(--radix-select-content-available-height))]">
            {PALETTE_OPTIONS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                leading={<PaletteSwatch preview={option.preview[resolvedTheme]} size={20} />}
                description={option.description}
                className="py-2"
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
