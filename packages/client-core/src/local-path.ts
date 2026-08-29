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

/**
 * A file path relative to a workspace root, suitable for the workspace file
 * API. Markdown file links commonly include a leading `./`, percent-encoding,
 * or a source location suffix; none of those belong in the daemon request.
 */
export function parseWorkspaceFilePath(
  raw: string | null | undefined,
): string | null {
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

  candidate = candidate
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/#L\d+(?:-L?\d+)?$/i, '')
    .replace(/:\d+(?::\d+)?$/, '')

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
  return components.join('/')
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
