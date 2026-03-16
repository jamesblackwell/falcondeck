import type { GitFileStatus } from '@falcondeck/client-core'

export function dirPart(path: string) {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(0, idx + 1) : ''
}

export function basePart(path: string) {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

export function stripPrefix(content: string) {
  if (content.length > 0 && (content[0] === '+' || content[0] === '-' || content[0] === ' ')) {
    return content.slice(1)
  }
  return content
}

export type FileStatusVariant = 'success' | 'danger' | 'info' | 'warning' | 'muted'

export function statusVariant(status: GitFileStatus): FileStatusVariant {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'success'
    case 'deleted':
      return 'danger'
    case 'modified':
      return 'info'
    case 'renamed':
    case 'copied':
      return 'warning'
    default:
      return 'muted'
  }
}
