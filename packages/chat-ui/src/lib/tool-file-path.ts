import { stripFileLocation } from '@falcondeck/client-core'

import { languageFromPath } from './shiki'

export { fileBaseName } from '@falcondeck/client-core'

/** Characters a path token may consist of once quoting and punctuation are stripped. */
const PATH_TOKEN_RE = /^[@~./\w-]+$/

/**
 * The file a tool call acted on, recovered from a title that names it only in
 * passing — a whole shell command, say. `describeToolCall` in client-core
 * answers the common `Edit src/App.tsx` shape; this is the looser scan for
 * what is left, preferring a token whose extension names a language it can
 * highlight.
 */
export function extractFilePath(text: string | null | undefined): string | null {
  if (!text) return null

  let fallback: string | null = null
  for (const rawToken of text.split(/[\s,;()[\]{}<>'"`|]+/)) {
    if (!rawToken || rawToken.startsWith('-') || rawToken.includes('://')) continue

    const token = stripFileLocation(rawToken).replace(/[.,:;]+$/, '')
    if (!token || !PATH_TOKEN_RE.test(token)) continue

    const base = token.split('/').pop() ?? token
    if (!base.includes('.') || base.startsWith('.')) continue

    if (languageFromPath(token)) return token
    if (token.includes('/')) fallback ??= token
  }

  return fallback
}
