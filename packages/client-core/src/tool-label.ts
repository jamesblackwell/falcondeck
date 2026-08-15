import type { ConversationItem } from './types'

type ToolCallItem = Extract<ConversationItem, { kind: 'tool_call' }>

/** Enough of a tool call to label it; keeps callers free of the full item shape. */
export type ToolCallLabelSource = Pick<ToolCallItem, 'title'> &
  Partial<Pick<ToolCallItem, 'output' | 'detail'>>

/** `/bin/zsh -lc 'git diff --stat'` is a wrapper, not the work the agent did. */
const SHELL_WRAPPER_RE = /^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/

/**
 * Verbs whose sole argument is a file, so the path can shrink to its name.
 * Deliberately excludes search-shaped verbs (Find, Search) whose argument is a
 * pattern that may contain slashes and must survive intact.
 */
const FILE_VERBS = new Set([
  'add',
  'append',
  'apply',
  'create',
  'delete',
  'diff',
  'edit',
  'multiedit',
  'notebookedit',
  'open',
  'patch',
  'read',
  'remove',
  'rename',
  'update',
  'view',
  'write',
])

/**
 * Names that say nothing on their own, so they keep their parent directory.
 * `index.ts` is every second file in a TypeScript tree; `Kernel.php` is not.
 */
const AMBIGUOUS_BASENAMES = new Set([
  '__init__',
  'config',
  'constants',
  'helpers',
  'index',
  'init',
  'layout',
  'lib',
  'main',
  'mod',
  'page',
  'route',
  'types',
  'utils',
])

/**
 * Result phrasings that name the file a tool touched. Kept to exact sentences
 * rather than scanning output for path-shaped tokens: a read's output is file
 * content, and any path inside it belongs to the code, not to the tool call.
 */
const OUTPUT_PATH_PATTERNS = [
  /^The file (.+?) has been (?:updated|created|written)/m,
  /^File created successfully at:\s*(.+?)\s*$/m,
  /^Applied \d+ edits? to (.+?)(?::|\s*$)/m,
]

function unwrapShellCommand(title: string) {
  const shellMatch = SHELL_WRAPPER_RE.exec(title)
  return shellMatch ? shellMatch[2].trim() : title
}

/** Agents cite locations as `src/app.ts:42` or `src/app.ts:42:7`. */
function stripLineLocation(token: string) {
  return token.replace(/:\d+(?::\d+)?$/, '')
}

function looksLikePath(token: string) {
  if (!token || token.includes('://') || token.startsWith('-')) return false
  if (!token.includes('/') && !token.includes('\\')) return false
  // A glob is a pattern over paths, not a path — shortening it loses its point.
  return !/[*?]/.test(token)
}

/**
 * The file a tool call names, at full length. Titles are freeform across
 * harnesses — `Edit /abs/path.ts` (Claude), ``Edit `/abs/path.ts` `` (Grok),
 * bare `Edit` with the path only in the result (older Claude history) — so this
 * reads the title first and falls back to the result's own phrasing.
 */
export function toolCallFilePath(item: ToolCallLabelSource): string | null {
  const parsed = parseTitle(item.title)
  if (parsed?.path) return parsed.path
  return outputFilePath(item)
}

/**
 * Header text for a tool call: the verb plus the file's name, never a
 * screen-wide absolute path. `Edit /Users/j/www/app/Console/Kernel.php` reads
 * as `Edit Kernel.php`; a bare `Edit` borrows the path from its own result.
 */
export function toolCallLabel(item: ToolCallLabelSource): string {
  const parsed = parseTitle(item.title)
  if (!parsed) return item.title.trim()
  if (parsed.path) {
    const compact = compactFilePath(parsed.path)
    return parsed.verb ? `${parsed.verb} ${compact}` : compact
  }
  // A bare file verb ("Edit", "Write") says what happened but not to what.
  if (!FILE_VERBS.has(parsed.title.toLowerCase())) return parsed.title
  const recovered = outputFilePath(item)
  return recovered ? `${parsed.title} ${compactFilePath(recovered)}` : parsed.title
}

/** Trailing path segment, plus its parent when the name alone says nothing. */
export function compactFilePath(path: string) {
  const segments = path.split(/[/\\]/).filter(Boolean)
  const base = segments[segments.length - 1]
  if (!base) return path
  if (segments.length < 2) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return AMBIGUOUS_BASENAMES.has(stem.toLowerCase())
    ? `${segments[segments.length - 2]}/${base}`
    : base
}

function parseTitle(rawTitle: string) {
  const title = unwrapShellCommand(rawTitle.trim())
  if (!title) return null

  // `Edit `/abs/path`` (ACP agents quote the path) and a naked path both end in
  // a single trailing token; anything longer is prose or a shell command.
  const match = /^(?:([A-Za-z][A-Za-z ]{0,20}?)\s+)?`?([^\s`]+)`?$/.exec(title)
  if (!match) return { title, verb: null, path: null }

  const verb = match[1]?.trim() ?? null
  // The leading word carries the verb; the rest qualifies it ("Edit notebook").
  const head = verb?.split(/\s+/)[0].toLowerCase()
  if (head && !FILE_VERBS.has(head)) return { title, verb: null, path: null }

  const path = stripLineLocation(match[2])
  return looksLikePath(path) ? { title, verb, path } : { title, verb: null, path: null }
}

function outputFilePath(item: ToolCallLabelSource): string | null {
  const fromDetail = detailFilePath(item.detail)
  if (fromDetail) return fromDetail
  const output = item.output
  if (!output) return null
  for (const pattern of OUTPUT_PATH_PATTERNS) {
    const match = pattern.exec(output)
    const path = match?.[1]?.trim()
    if (path && looksLikePath(path)) return path
  }
  return null
}

function detailFilePath(detail: ToolCallItem['detail']): string | null {
  if (!detail) return null
  const args =
    detail.kind === 'dynamic' || detail.kind === 'mcp' ? detail.arguments : null
  if (!args || typeof args !== 'object') return null
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'notebook_path']) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && looksLikePath(value)) return value
  }
  return null
}
