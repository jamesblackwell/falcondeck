import { useMemo } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

import {
  DARK_COLOR_THEME_OPTIONS,
  FONT_SCALE_OPTIONS,
  FONT_WEIGHT_OPTIONS,
  LIGHT_COLOR_THEME_OPTIONS,
  MONO_FONT_OPTIONS,
  SANS_FONT_OPTIONS,
  SURFACE_SCALE_OPTIONS,
  THEME_OPTIONS,
  sanitizeFontName,
  updateAppearance,
  usePersistedAppearance,
  type AppearanceSettings,
  type ColorThemeOption,
  type ColorThemeSetting,
  type DarkColorThemeSetting,
  type FontOption,
  type LightColorThemeSetting,
  type PalettePreview,
  type ThemeSetting,
} from '../lib/appearance'
import { cn } from '../lib/utils'
import { Input } from './input'
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

function ColorThemePicker({
  title,
  hint,
  value,
  options,
  onValueChange,
}: {
  title: string
  hint: string
  value: ColorThemeSetting
  options: readonly ColorThemeOption[]
  onValueChange: (value: string) => void
}) {
  const activeTheme = options.find((option) => option.value === value) ?? options[0]
  return (
    <section className="space-y-3">
      <GroupLabel title={title} hint={hint} />
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          aria-label={title}
          className="h-10 w-full justify-between gap-2 px-3 text-[length:var(--fd-text-sm)] text-fg-primary"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <PaletteSwatch preview={activeTheme.preview} />
            <span className="truncate">{activeTheme.label}</span>
          </span>
        </SelectTrigger>
        <SelectContent viewportClassName="max-h-[min(26rem,var(--radix-select-content-available-height))]">
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              leading={<PaletteSwatch preview={option.preview} size={20} />}
              description={option.description}
              className="py-2"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  )
}

/**
 * Theme-mode and palette pickers backed by the shared appearance store.
 * Kept separate from typography controls so focused surfaces such as
 * onboarding can offer appearance without exposing every display setting.
 */
export function ThemeControls() {
  const appearance = usePersistedAppearance()

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

      <ColorThemePicker
        title="Light theme"
        hint="Used when FalconDeck or this device is in light appearance."
        value={appearance.lightColorTheme}
        options={LIGHT_COLOR_THEME_OPTIONS}
        onValueChange={(value) =>
          updateAppearance({ lightColorTheme: value as LightColorThemeSetting })
        }
      />

      <ColorThemePicker
        title="Dark theme"
        hint="Used when FalconDeck or this device is in dark appearance."
        value={appearance.darkColorTheme}
        options={DARK_COLOR_THEME_OPTIONS}
        onValueChange={(value) =>
          updateAppearance({ darkColorTheme: value as DarkColorThemeSetting })
        }
      />
    </div>
  )
}

/** Soft availability probe; bundled and installed families both pass. */
function fontInstalled(name: string): boolean | null {
  const clean = sanitizeFontName(name)
  if (!clean) return null
  try {
    if (typeof document === 'undefined' || !document.fonts?.check) return null
    return document.fonts.check(`16px "${clean}"`)
  } catch {
    return null
  }
}

function CustomFontInput({
  value,
  sampleStack,
  onChange,
}: {
  value: string
  sampleStack: string
  onChange: (name: string) => void
}) {
  const installed = useMemo(() => fontInstalled(value), [value])
  return (
    <div className="space-y-1.5">
      <Input
        value={value}
        placeholder="Font name, exactly as in Font Book — e.g. Atkinson Hyperlegible"
        aria-label="Custom font name"
        spellCheck={false}
        style={value && installed ? { fontFamily: sampleStack } : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && installed === false ? (
        <p className="text-[length:var(--fd-text-xs)] text-warning">
          Not found on this Mac — check the family name in Font Book.
        </p>
      ) : null}
    </div>
  )
}

/**
 * One font dropdown: every row previews in its own face, and choosing
 * "Custom…" reveals a free-text family-name input beneath.
 */
function FontFamilyPicker({
  title,
  hint,
  value,
  customName,
  options,
  matchLabel,
  sampleText,
  onChange,
  onCustomNameChange,
}: {
  title: string
  hint: string
  value: string
  customName: string
  options: ReadonlyArray<FontOption<string>>
  /** When set, prepends a "match the interface font" row with this label. */
  matchLabel?: string
  sampleText: string
  onChange: (value: string) => void
  onCustomNameChange: (name: string) => void
}) {
  const active = options.find((option) => option.value === value)
  const customStack = customName ? `"${sanitizeFontName(customName)}", sans-serif` : undefined
  const triggerLabel =
    value === 'match'
      ? matchLabel
      : value === 'custom'
        ? customName || 'Custom…'
        : active?.label
  const triggerStack =
    value === 'match' ? undefined : value === 'custom' ? customStack : active?.stack
  return (
    <section className="space-y-3">
      <GroupLabel title={title} hint={hint} />
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          aria-label={title}
          className="h-10 w-full justify-between gap-2 px-3 text-[length:var(--fd-text-sm)] text-fg-primary"
        >
          <span className="truncate" style={triggerStack ? { fontFamily: triggerStack } : undefined}>
            {triggerLabel}
          </span>
        </SelectTrigger>
        <SelectContent viewportClassName="max-h-[min(26rem,var(--radix-select-content-available-height))]">
          {matchLabel ? (
            <SelectItem value="match" description="Follow the interface font." className="py-2">
              {matchLabel}
            </SelectItem>
          ) : null}
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              description={option.description}
              className="py-2"
            >
              <span
                style={option.value === 'custom' ? undefined : { fontFamily: option.stack }}
              >
                {option.value === 'custom' ? option.label : sampleText}
              </span>
              {option.value !== 'custom' ? (
                <span className="ml-2 text-fg-muted">{option.label}</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value === 'custom' ? (
        <CustomFontInput
          value={customName}
          sampleStack={customStack ?? 'sans-serif'}
          onChange={onCustomNameChange}
        />
      ) : null}
    </section>
  )
}

function TweakSelect({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string
  value: number
  options: ReadonlyArray<{ value: number; label: string }>
  onValueChange: (value: number) => void
}) {
  const active = options.find((option) => option.value === value) ?? options[0]
  return (
    <Select value={String(value)} onValueChange={(next) => onValueChange(Number(next))}>
      <SelectTrigger
        aria-label={label}
        className="h-8 w-full justify-between gap-1 px-2.5 text-[length:var(--fd-text-xs)] text-fg-primary"
      >
        <span className="truncate">{active.label}</span>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={String(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type SurfaceTweakRow = {
  label: string
  scaleKey: 'sidebarScale' | 'chatScale' | 'codeScale' | null
  weightKey: 'uiWeight' | 'sidebarWeight' | 'chatWeight' | 'codeWeight'
}

const SURFACE_TWEAK_ROWS: SurfaceTweakRow[] = [
  { label: 'Interface', scaleKey: null, weightKey: 'uiWeight' },
  { label: 'Sidebar', scaleKey: 'sidebarScale', weightKey: 'sidebarWeight' },
  { label: 'Chat', scaleKey: 'chatScale', weightKey: 'chatWeight' },
  { label: 'Code', scaleKey: 'codeScale', weightKey: 'codeWeight' },
]

/**
 * Theme, font, and text-size pickers backed by the shared appearance store.
 * Presentation-free at the edges so both the desktop settings page and the
 * remote web preferences modal can embed it.
 */
export function AppearanceControls() {
  const appearance = usePersistedAppearance()

  return (
    <div className="space-y-6">
      <ThemeControls />

      <FontFamilyPicker
        title="Interface font"
        hint="Used for all app text outside of code."
        value={appearance.sansFont}
        customName={appearance.sansFontCustom}
        options={SANS_FONT_OPTIONS}
        sampleText="The quick brown fox"
        onChange={(value) => updateAppearance({ sansFont: value as AppearanceSettings['sansFont'] })}
        onCustomNameChange={(name) => updateAppearance({ sansFontCustom: name })}
      />

      <FontFamilyPicker
        title="Chat font"
        hint="Used for conversation transcripts."
        value={appearance.chatFont}
        customName={appearance.chatFontCustom}
        options={SANS_FONT_OPTIONS}
        matchLabel="Match interface"
        sampleText="The quick brown fox"
        onChange={(value) => updateAppearance({ chatFont: value as AppearanceSettings['chatFont'] })}
        onCustomNameChange={(name) => updateAppearance({ chatFontCustom: name })}
      />

      <FontFamilyPicker
        title="Code font"
        hint="Used for terminal output, diffs, and code blocks."
        value={appearance.monoFont}
        customName={appearance.monoFontCustom}
        options={MONO_FONT_OPTIONS}
        sampleText="mv {} && exit 0"
        onChange={(value) => updateAppearance({ monoFont: value as AppearanceSettings['monoFont'] })}
        onCustomNameChange={(name) => updateAppearance({ monoFontCustom: name })}
      />

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

      <section className="space-y-3">
        <GroupLabel
          title="Fine-tune"
          hint="Size and base weight per surface. Headings and labels keep their own weights."
        />
        <div className="grid grid-cols-[minmax(0,1fr)_6rem_7.5rem] items-center gap-x-2 gap-y-2">
          <span className="text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em] text-fg-muted" />
          <span className="text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em] text-fg-muted">
            Size
          </span>
          <span className="text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em] text-fg-muted">
            Weight
          </span>
          {SURFACE_TWEAK_ROWS.map((row) => (
            <div key={row.label} className="contents">
              <span className="text-[length:var(--fd-text-sm)] text-fg-secondary">{row.label}</span>
              {row.scaleKey ? (
                <TweakSelect
                  label={`${row.label} text size`}
                  value={appearance[row.scaleKey]}
                  options={SURFACE_SCALE_OPTIONS}
                  onValueChange={(value) =>
                    updateAppearance({ [row.scaleKey as string]: value } as Partial<AppearanceSettings>)
                  }
                />
              ) : (
                <span
                  className="px-2.5 text-[length:var(--fd-text-xs)] text-fg-muted"
                  title="Interface size is the Text size setting above."
                >
                  Text size
                </span>
              )}
              <TweakSelect
                label={`${row.label} font weight`}
                value={appearance[row.weightKey]}
                options={FONT_WEIGHT_OPTIONS}
                onValueChange={(value) =>
                  updateAppearance({ [row.weightKey]: value } as Partial<AppearanceSettings>)
                }
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
