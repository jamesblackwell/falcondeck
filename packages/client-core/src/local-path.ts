const MAX_LOCAL_PATH_LENGTH = 1024

const POSIX_ROOTS = new Set([
  'Applications',
  'Library',
  'System',
  'Users',
  'Volumes',
  'bin',
  'etc',
  'home',
  'mnt',
  'opt',
  'private',
  'root',
  'sbin',
  'tmp',
  'usr',
  'var',
])

const POSIX_ROOT_ALTERNATIVES = [...POSIX_ROOTS].join('|')

/**
 * Absolute filesystem tokens in prose: a known Unix root, a home path, a
 * file:// URL, or a Windows drive path. The lookbehind keeps `/Users` inside
 * `https://example.com/Users/foo` from lighting up.
 */
const LOCAL_PATH_IN_TEXT = new RegExp(
  `(?<![A-Za-z0-9:/])(?:~\/[^\\s<>"'\`)]+|/(?:${POSIX_ROOT_ALTERNATIVES})(?:/[^\\s<>"'\`)]*)*|file://[^\\s<>"'\`)]+|[A-Za-z]:[\\\\/][^\\s<>"'\`)]*)`,
  'g',
)

export type LocalPathSegment = {
  kind: 'text' | 'path'
  value: string
}

function hasControlChars(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

export function unwrapPathCandidate(raw: string): string {
  let text = raw.trim()
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim()
  }
  if (text.length > 1 && !text.endsWith('/') && /[.,:;!?)]+$/.test(text)) {
    text = text.replace(/[.,:;!?)]+$/, '')
  }
  return text
}

export function decodeFileUrl(value: string): string | null {
  const raw = value.trim()
  if (!raw.toLowerCase().startsWith('file://')) return null
  const rest = raw.slice('file://'.length)
  let pathPart: string
  if (rest.startsWith('/')) {
    pathPart = rest
  } else {
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    const host = rest.slice(0, slash)
    const normalizedHost = host.toLowerCase()
    if (
      normalizedHost &&
      normalizedHost !== 'localhost' &&
      normalizedHost !== '127.0.0.1'
    ) return null
    pathPart = rest.slice(slash)
  }
  try {
    pathPart = decodeURIComponent(pathPart)
  } catch {
    return null
  }
  if (/^\/[A-Za-z]:[\\/]/.test(pathPart)) {
    pathPart = pathPart.slice(1)
  }
  return pathPart
}

export function isLocalFilePath(path: string): boolean {
  if (!path || path.length > MAX_LOCAL_PATH_LENGTH) return false
  if (hasControlChars(path)) return false
  if (path.includes('://')) return false
  if (path.startsWith('~/')) return path.length > 2
  if (path.startsWith('/')) {
    const root = path.split('/').find(Boolean)
    return Boolean(root && POSIX_ROOTS.has(root))
  }
  return /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Absolute local filesystem path, or null when the token is a web route,
 * relative path, or otherwise not safe to hand to the OS opener.
 */
export function parseLocalFilePath(raw: string | null | undefined): string | null {
  if (!raw) return null
  const candidate = unwrapPathCandidate(raw)
  if (!candidate || candidate.length > MAX_LOCAL_PATH_LENGTH) return null
  const decoded = candidate.toLowerCase().startsWith('file:')
    ? decodeFileUrl(candidate)
    : candidate
  if (!decoded) return null
  return isLocalFilePath(decoded) ? decoded : null
}

export type WorkspaceFileReference = {
  /** Workspace-relative path with no leading `./` or location suffix. */
  path: string
  /** 1-based line from a `:12`, `:12:4`, `:12-20` or `#L12` suffix. */
  line: number | null
}

/**
 * Splits a trailing source location off a path. Agents cite code as
 * `path:line`, `path:line:col`, `path:from-to` or `path#Lfrom-Lto`; the
 * file API wants none of that, while the viewer wants the first line.
 */
function splitLocationSuffix(candidate: string): {
  path: string
  line: number | null
} {
  const hashMatch = /#L(\d+)(?:-L?\d+)?$/i.exec(candidate)
  if (hashMatch) {
    return {
      path: candidate.slice(0, hashMatch.index),
      line: parseLineNumber(hashMatch[1]),
    }
  }
  const colonMatch = /:(\d+)(?::\d+|-\d+)?$/.exec(candidate)
  if (colonMatch) {
    return {
      path: candidate.slice(0, colonMatch.index),
      line: parseLineNumber(colonMatch[1]),
    }
  }
  return { path: candidate, line: null }
}

function parseLineNumber(digits: string): number | null {
  const line = Number.parseInt(digits, 10)
  return Number.isSafeInteger(line) && line > 0 ? line : null
}

/**
 * A file path relative to a workspace root, suitable for the workspace file
 * API, plus the line it pointed at. Markdown file links and inline code
 * commonly include a leading `./`, percent-encoding, or a source location
 * suffix; only the line survives, and only for the viewer.
 */
export function parseWorkspaceFileReference(
  raw: string | null | undefined,
): WorkspaceFileReference | null {
  if (!raw) return null
  let candidate = raw.trim()
  if (!candidate || candidate.length > MAX_LOCAL_PATH_LENGTH) return null
  if (
    candidate.includes('://') ||
    /^(?:data|file|javascript|mailto|tel):/i.test(candidate)
  ) {
    return null
  }

  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    return null
  }

  const { path, line } = splitLocationSuffix(
    candidate.replace(/\\/g, '/').replace(/^\.\//, ''),
  )
  candidate = path

  if (
    hasControlChars(candidate) ||
    candidate.startsWith('/') ||
    candidate.startsWith('~/') ||
    /^[A-Za-z]:\//.test(candidate)
  ) {
    return null
  }

  const components = candidate.split('/')
  if (
    components.length === 0 ||
    components.some(
      (component) =>
        !component ||
        component === '.' ||
        component === '..' ||
        component.includes('?') ||
        component.includes('#'),
    )
  ) {
    return null
  }
  return { path: components.join('/'), line }
}

/**
 * A file path relative to a workspace root, suitable for the workspace file
 * API. See `parseWorkspaceFileReference` for what gets stripped.
 */
export function parseWorkspaceFilePath(
  raw: string | null | undefined,
): string | null {
  return parseWorkspaceFileReference(raw)?.path ?? null
}

/**
 * Inline code that plausibly names a file in the workspace: a relative path
 * such as `src/app.ts`, `./README.md`, or `App.tsx:120`. The rule is loose on
 * purpose; the host confirms the file exists before the token becomes a link.
 * Absolute paths and URLs are someone else's job.
 */
export function looksLikeWorkspaceFileReference(text: string): boolean {
  const candidate = text.trim()
  if (!candidate || candidate.length > MAX_LOCAL_PATH_LENGTH) return false
  if (/[\s()[\]{}<>=$`"',;*|]/.test(candidate)) return false
  if (candidate.includes('://')) return false
  if (/^[-@]/.test(candidate)) return false
  if (parseLocalFilePath(candidate)) return false
  const reference = parseWorkspaceFileReference(candidate)
  if (!reference) return false
  if (reference.path.includes('/')) return true
  // A bare file name needs an extension, or `foo.bar` in prose would qualify.
  // Uppercase extensions are usually `process.env.FOO`, not files.
  return /^[^.].*\.[a-z][a-z0-9]{0,7}$/.test(reference.path)
}

/**
 * Where an absolute path lands inside `workspaceRoot`, as a reference the
 * workspace file API accepts. Null when the path is elsewhere or not local.
 */
export function workspaceFileReferenceFromLocalPath(
  path: string,
  workspaceRoot: string | null | undefined,
): WorkspaceFileReference | null {
  if (!workspaceRoot) return null
  const local = parseLocalFilePath(path)
  if (!local) return null

  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = local.replace(/\\/g, '/')
  if (normalized === root) return null
  const prefix = `${root}/`
  if (!normalized.startsWith(prefix)) return null
  return parseWorkspaceFileReference(normalized.slice(prefix.length))
}

/**
 * Harness tool calls often name a file by its absolute path. The workspace
 * file and git APIs want a path relative to the project root; this strips
 * that prefix when the absolute path sits inside `workspaceRoot`, and leaves
 * already-relative paths alone.
 */
export function workspaceRelativeFilePath(
  path: string,
  workspaceRoot: string | null | undefined,
): string {
  const relative = parseWorkspaceFilePath(path)
  if (relative) return relative
  return workspaceFileReferenceFromLocalPath(path, workspaceRoot)?.path ?? path
}

/** Splits plain text into ordinary runs and absolute local filesystem paths. */
export function splitLocalPathSegments(text: string): LocalPathSegment[] {
  const segments: LocalPathSegment[] = []
  let cursor = 0

  for (const match of text.matchAll(LOCAL_PATH_IN_TEXT)) {
    const start = match.index ?? 0
    const raw = match[0]
    const displayed = unwrapPathCandidate(raw)
    if (!parseLocalFilePath(displayed)) continue
    if (start > cursor) {
      segments.push({ kind: 'text', value: text.slice(cursor, start) })
    }
    segments.push({ kind: 'path', value: displayed })
    cursor = start + displayed.length
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', value: text.slice(cursor) })
  }
  return segments
}
