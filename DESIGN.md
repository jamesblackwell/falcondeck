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

FalconDeck uses a dark-first layered surface scale.

Backgrounds:

- `--fd-bg-0`: `#09090b`
- `--fd-bg-1`: `#111113`
- `--fd-bg-2`: `#1a1a1f`
- `--fd-bg-3`: `#232329`
- `--fd-bg-4`: `#2c2c34`

Foreground:

- `--fd-fg-0`: `#f4f4f6`
- `--fd-fg-1`: `#c4c4cc`
- `--fd-fg-2`: `#8e8e99`
- `--fd-fg-3`: `#62626d`
- `--fd-fg-4`: `#42424a`

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
- On mobile, mirror the same meaning through `colors.surface`, `colors.fg`, `colors.border`, and `colors.accent`.
- Do not introduce new brand colors without updating both token systems.

## Typography

Web:

- Sans: Geist, then Inter/system fallbacks
- Mono: Geist Mono, then SF Mono/JetBrains Mono/system fallbacks

Mobile:

- Sans currently uses Inter
- Mono uses SF Mono on iOS and JetBrains Mono elsewhere

Type scale:

- Small UI text starts at `12px`
- Default body text is `15px` web and `16px` mobile
- Heading scale tops out at `32px`

Rules:

- Prefer medium and semibold weight for structure instead of oversized text
- Use mono selectively for paths, ids, timestamps, and machine output
- Keep copy dense but readable; FalconDeck is a tool, not a marketing-heavy product surface

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
