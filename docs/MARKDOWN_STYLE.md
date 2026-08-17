# Markdown style contract

FalconDeck renders Markdown twice, from two hand-written renderers:

- **Desktop and remote web** — `packages/chat-ui/src/components/message-markdown.tsx`,
  with the prose scope in `packages/ui/src/styles.css` (`.fd-markdown`).
- **Mobile** — `apps/mobile/src/components/chat/MarkdownRenderer.tsx`, with tokens
  in `apps/mobile/src/theme/tokens.ts`.

They are two implementations of the one design below. Both had drifted from
each other before this document existed — heading scale, leading, list markers,
and table chrome had each diverged silently. **Change this file first, then
change both renderers.**

Sizes below are the token step, not a literal pixel value: every size scales
with the appearance text-size setting (`--fd-font-scale` on web,
`scaledFontSize` on mobile). Mobile's ramp deliberately sits one step above
web's — phone reading distance and glare make web-sized body copy feel cramped.

## Blocks

| Element | Desktop | Mobile |
| --- | --- | --- |
| Paragraph | `1em` (`--fd-text-md`), leading `relaxed` (1.65), 12px below | `base` (17), leading `relaxed`, 12px container gap |
| h1 | `1.45em`, 600, tracking tight, 32 above / 12 below | `2xl`, 600, tracking −0.4, 24 above |
| h2 | `1.25em`, 600, tracking tight, 32 above / 12 below | `xl`, 600, tracking −0.3, 20 above |
| h3 | `1.1em`, 600, tracking tight, 24 above / 8 below | `lg`, 600, tracking −0.2, 12 above |
| h4 | `1em`, 600, 20 above / 8 below | `md`, 600, 8 above |
| h5 | mono microlabel (`--md`), uppercase, `fg-tertiary` | mono `xs`, uppercase, tracking 1.2, `fg.tertiary` |
| h6 | mono microlabel, uppercase, `fg-muted` | mono `2xs`, uppercase, tracking 1.2, `fg.muted` |
| Blockquote | 2px accent bar, 16px indent, upright | 2px accent bar, 12px indent, upright |
| Code block | 32px above and below, `sm`, leading `code` (1.55), bordered card | identical |
| Table | bordered card, filled header row, cells 12/8, tabular figures | identical |
| Rule | 48×2px centred, fully rounded | identical |
| List | 6px between items, marker `fg-muted` | 8px between items, marker `fg.muted` |
| Task list | themed checkbox, accent fill, tick in the canvas colour | 18px box, same fill and tick |

Two rules that carry most of the rhythm:

1. **Headings take about twice as much space above as below.** A heading binds
   to the prose it introduces; when the gaps match, a document reads as one
   undifferentiated column.
2. **Prose and code keep different leading.** Prose is 1.65, code is 1.55
   (`--fd-leading-code` / `lineHeight.code`). Monospace lines are short and
   scanned vertically, so prose leading leaves a block looking loose.

## Inline

| Element | Desktop | Mobile |
| --- | --- | --- |
| Emphasis | real italic face (see below) | real italic face |
| Strong | 600, `fg-primary` | 600 |
| Inline code | `surface-4`, radius sm, `0.9em`, 1px block padding, wraps only when it must | `surface-3`, radius sm |
| Link | accent, underline at 40% opacity, thickens on hover | accent, underlined |
| Strikethrough | line-through | line-through |

Inline code uses `overflow-wrap: anywhere`, never `break-all`: a long
identifier should break only when it genuinely cannot fit, not at whatever
character happens to land on the column edge.

## Measure

Desktop prose fills the transcript column: `--fd-measure` is `none`.

A narrower measure was tried first (`calc(35 * var(--fd-text-md))`, about 70
characters) on the reasoning that the 3xl column runs to roughly 90 characters
per line. It was reverted because the column and the composer are both
`max-w-3xl` with the same padding, so capping prose left its right edge short
of the input box directly below it — which reads as a bug, not as typography.
Alignment with the composer won over line length.

To reinstate a book measure, set `--fd-measure` to a length; code blocks,
diffs, and tables are already exempt and keep the full column either way.
Express it as a length rather than in `ch`: that unit resolves against each
element's own font size, so headings would get a wider measure than the
paragraphs below them, and `1ch` (the width of "0") exceeds the average
character, so `70ch` yields a line of roughly 85.

Mobile has no measure: the screen is already inside a comfortable one, and the
user bubble is capped at 80% width.

## Fonts

Both platforms ship Geist and Geist Mono rather than resolving system faces.

- **Desktop** loads the variable woff2 files from `apps/desktop/public/fonts`,
  including the italic faces. Without a real italic face every `<em>` is a
  synthesized oblique.
- **Mobile** bundles static TTFs through the `expo-font` config plugin in
  `apps/mobile/app.config.ts`. Only Regular/Bold/Italic/BoldItalic are bundled:
  Geist's Medium and SemiBold files declare their own compatible family names
  ("Geist SemiBold"), which iOS treats as separate families and would never
  match from `fontFamily: 'Geist'`. Weights 500 and 600 therefore resolve to the
  nearest bundled face on both platforms rather than rendering as a real weight
  on Android and a synthesized one on iOS.

Do not name a family in the theme that is not bundled. The failure is silent:
iOS falls back to San Francisco, and because third-party apps cannot use SF
Mono, a missing mono family means code renders in a *proportional* face.

## Syntax highlighting

Code inherits the active color theme. Each light or dark theme maps independently
to a same-appearance Shiki theme in `COLOR_THEME_THEMES` in
`packages/chat-ui/src/lib/shiki.ts`. Themes load as separate chunks, on demand,
exactly like grammars. Where a theme has no matching upstream Shiki port, the
neutral GitHub theme for that appearance stands in. FalconDeck's Matrix theme
ships its own on-demand Shiki definition.

Mobile does not tokenize; its code blocks are plain monospace text.

## Intentional divergences

- Mobile's size ramp sits one step above web's (see above).
- Neither platform constrains prose measure: desktop prose aligns with the
  composer, mobile fits the screen.
- Desktop balances heading wraps and uses `text-wrap: pretty` on prose; React
  Native has no equivalent.
- Mobile draws its task-list checkbox and tick natively; desktop restyles the
  browser's `input[type="checkbox"]`, which otherwise ignores the theme.
