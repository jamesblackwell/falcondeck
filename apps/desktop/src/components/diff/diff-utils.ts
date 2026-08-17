import type { GitFileStatus } from '@falcondeck/client-core'

export function dirPart(path: string) {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(0, idx + 1) : ''
}

export function basePart(path: string) {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

/**
 * Shortens a home-directory path the way a shell prompt does, so a checkout
 * path fits one line in a narrow panel. The full path stays available for the
 * tooltip and the clipboard — only the display is abbreviated.
 */
export function homeRelativePath(path: string) {
  const match = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path)
  return match ? `~${path.slice(match[0].length)}` : path
}

/** The single letter git itself uses for a status, as shown in file lists. */
export function statusLabel(status: GitFileStatus) {
  return status === 'untracked' ? 'U' : status.slice(0, 1).toUpperCase()
}

/** Colour for that letter, shared by every list that prints one. */
export function statusToneClass(status: GitFileStatus) {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'text-success'
    case 'deleted':
      return 'text-danger'
    case 'renamed':
    case 'copied':
      return 'text-warning'
    default:
      return 'text-info'
  }
}
