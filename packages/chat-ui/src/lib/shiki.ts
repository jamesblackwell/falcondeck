import { useEffect, useMemo, useState } from 'react'
import type {
  HighlighterCore,
  LanguageInput,
  ThemeRegistrationAny,
  ThemedToken,
} from 'shiki/core'

import {
  resolveColorTheme,
  resolveTheme,
  useAppearance,
  type ColorThemeSetting,
} from '@falcondeck/ui'

/* ================================================================
   Syntax highlighting for transcripts and the diff sidebar.

   shiki lives here rather than in apps/desktop so the transcript and
   the working-tree sidebar highlight identically, and so remote-web
   gets highlighting without a second implementation. The cost is
   affordable for remote-web — whose bundle ships over the relay —
   because the engine and themes sit behind dynamic imports and grammars
   load one at a time on demand, so nothing but the code the user actually
   looked at is ever fetched.
   ================================================================ */

/* Loaded with the highlighter, so they are always available: the neutral
   default palette uses them, and every other palette falls back to them for
   the mode its theme family does not draw. */
const DARK_THEME = 'github-dark-default'
const LIGHT_THEME = 'github-light-default'

/** Above this, tokenizing costs more than the highlighting is worth. */
const MAX_HIGHLIGHT_CHARS = 200_000

type LanguageModule = { default: LanguageInput }
type ThemeModule = { default: ThemeRegistrationAny }

/* Each color theme selects one syntax theme for its own appearance. Themes
   with no matching upstream Shiki port use a neutral theme of the same mode;
   they never force a dark syntax palette onto a light surface or vice versa. */
const COLOR_THEME_THEMES: Record<ColorThemeSetting, string> = {
  'falcon-light': LIGHT_THEME,
  'catppuccin-latte': 'catppuccin-latte',
  alucard: LIGHT_THEME,
  'gruvbox-light': 'gruvbox-light-medium',
  'nord-light': LIGHT_THEME,
  'one-light': 'one-light',
  'rose-pine-dawn': 'rose-pine-dawn',
  'solarized-light': 'solarized-light',
  'tokyo-night-light': LIGHT_THEME,
  'falcon-dark': DARK_THEME,
  'catppuccin-mocha': 'catppuccin-mocha',
  dracula: 'dracula',
  'gruvbox-dark': 'gruvbox-dark-medium',
  matrix: 'falcondeck-matrix',
  nord: 'nord',
  'one-dark': 'one-dark-pro',
  'rose-pine': 'rose-pine',
  'solarized-dark': 'solarized-dark',
  'tokyo-night': 'tokyo-night',
}

// Statically analyzable for the same reason as LANGUAGE_LOADERS: each theme
// becomes its own chunk, fetched only if the user actually picks that palette.
const THEME_LOADERS: Record<string, () => Promise<ThemeModule>> = {
  'catppuccin-latte': () => import('shiki/themes/catppuccin-latte.mjs'),
  'catppuccin-mocha': () => import('shiki/themes/catppuccin-mocha.mjs'),
  dracula: () => import('shiki/themes/dracula.mjs'),
  'gruvbox-dark-medium': () => import('shiki/themes/gruvbox-dark-medium.mjs'),
  'gruvbox-light-medium': () => import('shiki/themes/gruvbox-light-medium.mjs'),
  nord: () => import('shiki/themes/nord.mjs'),
  'one-dark-pro': () => import('shiki/themes/one-dark-pro.mjs'),
  'one-light': () => import('shiki/themes/one-light.mjs'),
  'rose-pine': () => import('shiki/themes/rose-pine.mjs'),
  'rose-pine-dawn': () => import('shiki/themes/rose-pine-dawn.mjs'),
  'solarized-dark': () => import('shiki/themes/solarized-dark.mjs'),
  'solarized-light': () => import('shiki/themes/solarized-light.mjs'),
  'tokyo-night': () => import('shiki/themes/tokyo-night.mjs'),
  'falcondeck-matrix': () => import('./themes/matrix'),
}

// Keep this map deliberately finite and statically analyzable. Importing the
// full `shiki` bundle makes Vite emit every bundled grammar and theme (roughly
// 11 MB at the time of writing), even though the browser only fetches them on
// demand. These are exactly the grammars normalizeLanguage can return, so the
// packaged desktop app and remote web client only ship capabilities FalconDeck
// actually exposes.
const LANGUAGE_LOADERS: Record<string, () => Promise<LanguageModule>> = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/github-dark-default.mjs'),
      import('shiki/themes/github-light-default.mjs'),
    ])
      .then(([shiki, engine, darkTheme, lightTheme]) =>
        shiki.createHighlighterCore({
          // Browser clients use Shiki's native-RegExp engine so the first
          // settled code block does not have to download and initialise the
          // 622 kB Oniguruma WASM payload. Shiki supports every bundled
          // language through this engine; individual grammars still load on
          // demand below and plain text remains the failure fallback.
          engine: engine.createJavaScriptRegexEngine(),
          themes: [darkTheme.default, lightTheme.default],
          langs: [],
        }),
      )
      // Clear the cache on failure: keeping a rejected promise would mean one
      // flaky chunk fetch disables highlighting for the whole session, even
      // after the network recovers. Callers fall back to plain text.
      .catch((error) => {
        highlighterPromise = null
        throw error
      })
  }
  return highlighterPromise
}

const themeLoads = new Map<string, Promise<boolean>>()

/** Resolves true once `theme` can be passed to `codeToTokens`. */
function ensureTheme(highlighter: HighlighterCore, theme: string) {
  if (theme === DARK_THEME || theme === LIGHT_THEME) return Promise.resolve(true)

  const pending = themeLoads.get(theme)
  if (pending) return pending

  const loader = THEME_LOADERS[theme]
  if (!loader) return Promise.resolve(false)

  const load = loader()
    .then((module) => highlighter.loadTheme(module.default))
    .then(() => true)
    .catch(() => {
      // Same reasoning as the grammar loads: one flaky chunk fetch must not
      // pin the session to the fallback theme forever.
      themeLoads.delete(theme)
      return false
    })
  themeLoads.set(theme, load)
  return load
}

const languageLoads = new Map<string, Promise<boolean>>()

function ensureLanguage(highlighter: HighlighterCore, language: string) {
  const pending = languageLoads.get(language)
  if (pending) return pending

  const loader = LANGUAGE_LOADERS[language]
  if (!loader) return Promise.resolve(false)

  const load = loader()
    .then((module) => highlighter.loadLanguage(module.default))
    .then(() => true)
    .catch(() => {
      // A transient grammar-chunk failure must not disable that language for
      // the rest of the session. The next render may run after connectivity
      // has recovered, so let it issue a fresh request.
      languageLoads.delete(language)
      return false
    })
  languageLoads.set(language, load)
  return load
}

/** File extensions and markdown fence tags mapped onto shiki grammar ids. */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  json: 'json',
  jsonc: 'json',
  rs: 'rust',
  rust: 'rust',
  py: 'python',
  python: 'python',
  go: 'go',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  shell: 'bash',
  console: 'bash',
  sql: 'sql',
  swift: 'swift',
  kt: 'kotlin',
  kotlin: 'kotlin',
  java: 'java',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  vue: 'vue',
  svelte: 'svelte',
  xml: 'xml',
  svg: 'xml',
  dockerfile: 'docker',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
}

/** Resolves a fence tag or bare extension to a grammar; null when unknown. */
export function normalizeLanguage(
  name: string | null | undefined,
): string | null {
  if (!name) return null
  return LANGUAGE_ALIASES[name.trim().toLowerCase()] ?? null
}

/** Resolves the grammar for a file path by its extension; null when unknown. */
export function languageFromPath(
  filePath: string | null | undefined,
): string | null {
  if (!filePath) return null
  const base = filePath.split('/').pop() ?? filePath
  if (base.toLowerCase().startsWith('dockerfile')) return 'docker'
  const ext = base.includes('.') ? base.split('.').pop() : null
  return normalizeLanguage(ext)
}

function useResolvedTheme(): string {
  const appearance = useAppearance()
  // `initAppearance` mirrors the resolved system appearance onto <html>, so
  // reading it back avoids a second media-query source in browser clients.
  const stampedAppearance = typeof document !== 'undefined'
    ? document.documentElement.dataset.theme
    : undefined
  const resolvedAppearance = stampedAppearance === 'light' || stampedAppearance === 'dark'
    ? stampedAppearance
    : resolveTheme(appearance.theme)
  const colorTheme = resolveColorTheme(appearance, resolvedAppearance)
  return COLOR_THEME_THEMES[colorTheme.value]
}

/**
 * Token arrays for each line of `lines`, highlighted with `language`. Returns
 * null — meaning "render as plain text" — while loading, for unknown grammars,
 * and for input too large to be worth tokenizing.
 */
export function useShikiTokens(
  lines: string[],
  language: string | null,
): ThemedToken[][] | null {
  const theme = useResolvedTheme()
  const code = useMemo(() => lines.join('\n'), [lines])
  const [highlighted, setHighlighted] = useState<{
    code: string
    language: string
    theme: string
    tokens: ThemedToken[][]
  } | null>(null)

  useEffect(() => {
    if (!language || code.length === 0 || code.length > MAX_HIGHLIGHT_CHARS) {
      setHighlighted(null)
      return
    }

    let cancelled = false

    void getHighlighter()
      .then(async (highlighter) => {
        if (cancelled) return
        const [loaded, themeLoaded] = await Promise.all([
          ensureLanguage(highlighter, language),
          ensureTheme(highlighter, theme),
        ])
        if (cancelled) return
        if (!loaded) {
          setHighlighted(null)
          return
        }

        try {
          const result = highlighter.codeToTokens(code, {
            lang: language,
            // A palette theme that failed to load falls back to the neutral
            // GitHub pair rather than dropping highlighting altogether.
            theme: themeLoaded
              ? theme
              : typeof document !== 'undefined' &&
                  document.documentElement.dataset.theme === 'light'
                ? LIGHT_THEME
                : DARK_THEME,
          })
          if (!cancelled) {
            setHighlighted({ code, language, theme, tokens: result.tokens })
          }
        } catch {
          if (!cancelled) setHighlighted(null)
        }
      })
      // The engine chunk can fail to load (offline, a host that rewrites
      // missing assets to index.html). Plain text is the right fallback, and
      // swallowing it here keeps it off the unhandled-rejection channel; the
      // next render retries because getHighlighter cleared its cache.
      .catch(() => {
        if (!cancelled) {
          setHighlighted(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [code, language, theme])

  // Effects run after paint. Tag token state with the exact inputs that
  // produced it so a render with changed code, language, or theme rejects the
  // old result synchronously instead of painting stale text for one frame.
  return highlighted?.code === code &&
    highlighted.language === language &&
    highlighted.theme === theme
    ? highlighted.tokens
    : null
}
