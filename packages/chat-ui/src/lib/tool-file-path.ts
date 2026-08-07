import { languageFromPath } from './shiki'

/** Characters a path token may consist of once quoting and punctuation are stripped. */
const PATH_TOKEN_RE = /^[@~./\w-]+$/

/**
 * The file a tool call acted on, recovered from its title. Titles are
 * freeform — `Edit src/App.tsx`, `cat crates/foo/src/lib.rs`, or a whole shell
 * command — so this reads the first token that is shaped like a path,
 * preferring one whose extension names a language it can highlight.
 */
export function extractFilePath(text: string | null | undefined): string | null {
  if (!text) return null

  let fallback: string | null = null
  for (const rawToken of text.split(/[\s,;()[\]{}<>'"`|]+/)) {
    if (!rawToken || rawToken.startsWith('-') || rawToken.includes('://')) continue

    // `src/app.ts:42` and `src/app.ts:42:7` are how agents cite locations.
    const token = rawToken.replace(/:\d+(?::\d+)?$/, '').replace(/[.,:;]+$/, '')
    if (!token || !PATH_TOKEN_RE.test(token)) continue

    const base = token.split('/').pop() ?? token
    if (!base.includes('.') || base.startsWith('.')) continue

    if (languageFromPath(token)) return token
    if (token.includes('/')) fallback ??= token
  }

  return fallback
}

/** Trailing path segment, for labelling a link without spending the whole row. */
export function fileBaseName(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() ?? filePath
}
