/**
 * File references in terminal output (`src/app.ts:12:4`, `./a/b.rs:3`,
 * `/abs/path.md`). ⌘-click opens them; URLs are left to the web-links addon.
 */
export type TerminalFileLink = {
  /** Column of the first character, 0-based. */
  start: number
  /** Matched text including any `:line:col` suffix. */
  text: string
  path: string
  line: number | null
  column: number | null
}

// A path segment: no whitespace, quotes, brackets or `:` (the line separator).
const SEGMENT = String.raw`[^\s:'"()<>\[\]{}|,;]+`
const FILE_LINK = new RegExp(
  String.raw`(?:~|\.{1,2})?\/?(?:${SEGMENT}\/)*${SEGMENT}(?::(\d+))?(?::(\d+))?`,
  'g',
)

export function findFileLinks(line: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = []
  for (const match of line.matchAll(FILE_LINK)) {
    let text = match[0]
    const start = match.index ?? 0
    // Part of a URL (`https://…`): the web-links addon owns those.
    if (/[a-z][a-z0-9+.-]*:\/*[^\s]*$/i.test(line.slice(0, start))) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line.slice(start))) continue
    // Trailing sentence punctuation is almost never part of the name.
    text = text.replace(/[.]+$/, '')
    const lineNumber = match[1] ? Number(match[1]) : null
    const column = match[2] ? Number(match[2]) : null
    const path = text.replace(/(?::\d+){1,2}$/, '')
    const hasSlash = path.includes('/')
    const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(path) && !/^\.+$/.test(path)
    // A bare word is only a file when it has a location suffix and an
    // extension (`main.rs:4`); anything with a slash needs an extension or a
    // location so plain prose like `and/or` stays unlinked.
    if (!hasSlash && !(hasExtension && lineNumber !== null)) continue
    if (hasSlash && !hasExtension && lineNumber === null) continue
    if (/^\d+(?:\.\d+)*$/.test(path)) continue
    links.push({ start, text, path, line: lineNumber, column })
  }
  return links
}

/** Absolute form of `path` relative to `cwd`, expanding `~` against `home`. */
export function resolveTerminalPath(path: string, cwd: string, home?: string | null): string {
  if (path.startsWith('/')) return normalize(path)
  if (path === '~' || path.startsWith('~/')) {
    return home ? normalize(`${home}${path.slice(1)}`) : path
  }
  return normalize(`${cwd.replace(/\/+$/, '')}/${path}`)
}

function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}
