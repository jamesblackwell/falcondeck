# FalconDeck Design System

## Purpose

This file is the shared visual source of truth for FalconDeck across desktop, mobile, remote web, and the public site. Use it when changing UI, branding, iconography, app metadata, or shared components.

Primary implementation sources:

- Web tokens: [packages/ui/src/styles.css](/Users/James/www/sites/falcondeck/packages/ui/src/styles.css)
- Mobile tokens: [apps/mobile/src/theme/tokens.ts](/Users/James/www/sites/falcondeck/apps/mobile/src/theme/tokens.ts)
- Brand assets: [assets/brand](/Users/James/www/sites/falcondeck/assets/brand)
- Asset generator: [scripts/generate-brand-assets.mjs](/Users/James/www/sites/falcondeck/scripts/generate-brand-assets.mjs)

## Visual Direction

FalconDeck should feel like a precision instrument, not a playful consumer app and not a glowing generic AI dashboard.

Traits:

- Dark, deliberate, quiet, technical
- High clarity over decoration
- Strong hierarchy through surface depth, not heavy gradients
- One accent family, used sparingly
- Clean silhouettes and restrained motion

Avoid:

- Purple-heavy "AI" styling
- Glossy metallic effects
- Unnecessary neon glows
- Overstuffed control surfaces
- Ad hoc one-off color choices

## Color System

FalconDeck is dark-first but fully themeable. All color flows through the
`--fd-*` tokens in `packages/ui/src/styles.css`; the default Falcon themes live
on `:root` and `:root[data-theme="light"]`, while other themes use
`data-palette`. The appearance module in `packages/ui/src/lib/appearance.ts`
stores an independent preferred light and dark theme. System mode selects
between those preferences as the device appearance changes. A named theme can
be light-only or dark-only; related themes such as Catppuccin Latte/Mocha share
a family, but no theme needs an invented opposite-mode variant. Mobile mirrors
the same catalogue in `apps/mobile/src/theme/tokens.ts` and updates the two
unistyles themes independently. Never hardcode a hex in a component — it will
break in at least one theme.

Contrast floors for every palette: `fg-0`–`fg-3` carry real copy and must hold
≥ 4.5:1 on `bg-1`; `fg-4` is decorative-only and must hold ≥ 3:1.

Default (Falcon dark) backgrounds:

- `--fd-bg-0`: `#09090b`
- `--fd-bg-1`: `#111113`
- `--fd-bg-2`: `#1a1a1f`
- `--fd-bg-3`: `#232329`
- `--fd-bg-4`: `#2c2c34`

Foreground:

- `--fd-fg-0`: `#f4f4f6`
- `--fd-fg-1`: `#c4c4cc`
- `--fd-fg-2`: `#9d9da8`
- `--fd-fg-3`: `#84848f`
- `--fd-fg-4`: `#6d6d78`

Borders:

- `--fd-border-0`: `rgba(255, 255, 255, 0.06)`
- `--fd-border-1`: `rgba(255, 255, 255, 0.10)`
- `--fd-border-2`: `rgba(255, 255, 255, 0.16)`
- `--fd-border-3`: `rgba(255, 255, 255, 0.24)`

Accent:

- `--fd-accent`: `#34d399`
- `--fd-accent-strong`: `#6ee7b7`
- Muted accent states should use the existing tokenized alpha variants, not new arbitrary greens.

Semantic colors:

- Success: green
- Warning: amber
- Danger: red
- Info: blue

Rules:

- Prefer token aliases like `bg-surface-1`, `text-fg-primary`, and `border-border-subtle` on web.
- Categorical colors (`--fd-cat-1` … `--fd-cat-12`, aliased as `bg-cat-1` / `text-cat-1`) are the non-semantic scale for project folders, charts, and similar labels. Store the token id, not a hex — each palette retints the same twelve slots.
- Use `bg-interactive-hover`, `bg-interactive-selected`, and `bg-interactive-active` for list and menu row states. These are derived from the active palette so custom themes retain clear interaction contrast.
- On mobile, mirror the same meaning through `colors.surface`, `colors.fg`, `colors.border`, and `colors.accent`.
- Do not introduce new brand colors without updating both token systems.
- For a translucent accent or semantic fill, reach for the tokenized `-muted` / `-dim` variant instead of an ad hoc alpha modifier like `bg-accent/10`.
- Web tokens are named `--fd-*`. There is no `--fd-color-*` prefix; the `--color-*` aliases exist only so Tailwind can generate `bg-surface-1` style utilities. A `var(--fd-color-…)` reference silently resolves to nothing.

## Typography

Web:

- Sans: Geist, then Inter/system fallbacks (user-overridable via the
  appearance settings — always reference `--font-sans` / `--fd-font-sans`,
  never a family name)
- Mono: Geist Mono, then SF Mono/JetBrains Mono/system fallbacks (same rule
  via `--font-mono` / `--fd-font-mono`)
- The `--fd-text-*` sizes multiply by `--fd-font-scale`, which the text-size
  setting overrides; size text with the tokens so user scaling keeps working.

Mobile:

- Sans currently uses Inter
- Mono uses SF Mono on iOS and JetBrains Mono elsewhere

Type scale:

- Small UI text starts at `12px`
- Default shell text is `15px` web; readable content is `16px` web
- Mobile deliberately runs one scale step larger (`17px` body) because native
  text renders smaller at the same nominal value
- Heading scale tops out at `32px`

Semantic roles:

- `body`: readable content, `16px` web with relaxed leading
- `supporting`: secondary descriptions and helper copy, `14px`
- `label`: names and control labels, `15px` medium
- `meta`: timestamps and compact supporting facts, `12px`
- `microlabel`: authored technical chrome, `11px` mono uppercase
- `heading`: section structure, `22px` semibold by default

Typography and emphasis are two separate decisions. Choose one role for size,
leading, weight, and tracking, then one foreground role: primary, secondary,
muted, or decorative. `fg-faint` is decorative and must not carry timestamps,
status, helper copy, or other information.

Rules:

- Prefer medium and semibold weight for structure instead of oversized text
- Use mono selectively for paths, ids, timestamps, and machine output
- Keep copy dense but readable; FalconDeck is a tool, not a marketing-heavy product surface
- On web, prefer the semantic `fd-type-*` roles. Tailwind's standard
  `text-*`, `leading-*`, and `tracking-*` utilities are mapped to FalconDeck's
  scalable tokens, so `text-sm` is valid and responds to the appearance text
  scale. Never use an arbitrary pixel size such as `text-[13px]`.
- On mobile, size text through `theme.fontSize.*`, and derive `lineHeight` as `fontSize * theme.lineHeight.*` rather than hardcoding a pixel value
- `--fd-text-md` (`16px`) is the deliberate size for text inputs on small screens, because anything smaller makes iOS Safari zoom on focus. Step down to `--fd-text-base` at the `md` breakpoint

## Spacing, Radius, and Depth

Spacing is on a 4px base scale.

Common values:

- `4`, `8`, `12`, `16`, `24`, `32`, `48`, `64`

Radius:

- Small controls: `6px`
- Standard controls: `8px`
- Cards and panels: `12px`
- Large panels and overlays: `16px`
- Pill shapes: full radius

Radius rules:

- Reference radii through tokens: `rounded-[var(--fd-radius-*)]` on web, `theme.radius.*` on mobile
- Pills and dots use the full radius token rather than a large magic number like `999` or half the width
- Icons follow their own scale: `theme.iconSize.*` on mobile, where `xs` (`14`) is the dense size used inside list rows and disclosure headers

Depth:

- Use surface steps before shadows
- Shadows should be soft and secondary
- Accent glow should stay subtle and only reinforce important focus or active states

## Component Guidance

Shared UI should generally live in `packages/ui` or `packages/chat-ui`, not be recreated app-by-app.

Rules:

- Prefer semantic wrappers over long utility-only markup
- Reuse the established panel, card, badge, button, input, and shell primitives
- Preserve the existing dark shell and sidebar hierarchy
- Treat spacing and border contrast as the primary layout language

When adding a new shared pattern:

- Start with token usage
- Check whether it belongs in `packages/ui`
- Keep states consistent across desktop, remote web, and mobile

## Interaction Patterns

These are the established cross-platform behaviours. Match them instead of inventing a new affordance for the same job.

### Context menus (per-item actions)

Secondary actions on a list item live in a context menu, never in a row of always-visible icon buttons.

- Desktop and remote web: right-click the row (`onContextMenu`), which opens a portalled menu with `role="menu"` positioned at the cursor. The menu closes on outside pointerdown, `Escape`, scroll, and resize.
- Mobile: long-press the row, which opens a bottom sheet with the same actions in the same order.

Rules:

- Keep the action list and its order identical across platforms.
- Order is: pin/unpin, rename, mark as read, then a separator, then copy actions, then a separator, then destructive actions last.
- Destructive items use `danger` foreground with a muted danger hover fill.
- If a menu is positioned manually, the width constant used for viewport clamping must match the rendered width, or the menu will overflow the screen edge.
- One action may also appear inline on hover as a shortcut (thread archive), but the context menu remains the complete list.

### Collapsible side panels

The desktop shell has two optional panels around the main column.

- `⌘B` toggles the left sidebar; `⌥⌘B` toggles the right side panel.
- Both toggles are also exposed as icon buttons with `aria-pressed` reflecting visibility, so the state is discoverable without the shortcut.
- Visibility persists across launches. The sidebar defaults to visible, the right panel to hidden.
- Hiding a panel unmounts it rather than shrinking it to zero width.

### Focus and keyboard access

Every interactive element must show a visible keyboard focus indicator.

- Web: apply the `fd-focus` class (or `fd-focus-inset` where an offset ring would be clipped by a scrolling parent). It renders an accent outline on `:focus-visible` only, so pointer interaction stays quiet. `Button`, `Input`, `Textarea`, `Select`, and `PanelHeader` already include it.
- Never use `outline-none` without providing a replacement indicator.
- An action that is only revealed on hover must also reveal itself on `focus-visible`, or keyboard users can tab to an invisible control.
- Icon-only controls need an `aria-label` on web and an `accessibilityLabel` plus `accessibilityRole="button"` on mobile. A `title` alone is not sufficient.

### Shortcut tooltips

Icon buttons and composer chips that a keyboard shortcut also drives use the shared `Tooltip` from `@falcondeck/ui`: a short label plus keycap tokens (`⌘`, `↵`), portalled so overflow parents cannot clip them. Do not use the native `title` attribute for those hints — it fights the custom tooltip and does not match the chrome. Truncated paths, overflow text, and status dots may still use `title`. The accessible name stays on `aria-label`; the tooltip is visual discoverability.

- Decorative icons sitting next to a text label should be `aria-hidden`.

### Touch targets

Mobile controls follow a 44pt minimum. When the painted control is deliberately smaller, keep the visual size and add `hitSlop` to reach 44pt rather than inflating the design.

## Overlays and Scrims

Two tiers only, tokenized on both platforms:

- `--fd-overlay` / `colors.overlay` — centered dialogs, popovers, and option sheets, where the surface underneath should stay legible.
- `--fd-overlay-strong` / `colors.overlayStrong` — full-screen drawers and sheets that own the viewport. Always paired with a backdrop blur.

Do not introduce a third scrim alpha.

## Brand and Logo System

Primary source files:

- [logomark-dark.svg](/Users/James/www/sites/falcondeck/assets/brand/logomark-dark.svg): full-bleed square app icon on dark background
- [logomark-light.svg](/Users/James/www/sites/falcondeck/assets/brand/logomark-light.svg): full-bleed square app icon on light background
- [logomark-mark-dark.svg](/Users/James/www/sites/falcondeck/assets/brand/logomark-mark-dark.svg): transparent dark falcon mark
- [logomark-mark-light.svg](/Users/James/www/sites/falcondeck/assets/brand/logomark-mark-light.svg): transparent light falcon mark

Usage:

- Use the full-bleed square icon for primary app/store icon surfaces
- Use the transparent mark for favicons, pinned tabs, overlays, and composited icon assets
- Do not redraw, distort, bevel, outline, or add glow treatments to the falcon mark

## Platform Asset Rules

Generated outputs are produced by:

```bash
npm run brand:generate
```

This updates:

- `apps/mobile/assets`
- `apps/desktop/public`
- `apps/desktop/src-tauri/icons`
- `apps/site/public`
- `apps/remote-web/public`

Platform rules:

- iOS and general app-store icon surfaces use the full-bleed square icon
- Android adaptive icons use a padded transparent foreground plus dark background color
- Android monochrome icon uses the transparent mark for themed icons
- Splash screens use the transparent mark centered on the dark background
- Web manifests include regular and maskable icons
- Browser heads should include SVG favicon, PNG fallbacks, apple touch icon, pinned-tab icon, and manifest
- Desktop/Tauri icons should be regenerated through the Tauri icon tool, not hand-edited one by one

If the source logo changes, regenerate instead of patching each app manually.

## Practical Rules For Contributors

- Read this file before changing shared UI or branding
- Read `packages/ui/src/styles.css` before inventing new tokens
- Read `apps/mobile/src/theme/tokens.ts` before diverging on mobile
- Keep design choices synchronized across desktop, remote web, and mobile when the surface is product UI
- Keep the public site visually related, but simpler and more marketing-oriented than the product surfaces
