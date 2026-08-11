import type { WebSearchActionKind } from './types'

function humanizeAction(value: string) {
  const words = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Web research'
}

/** Honest active/terminal copy for known and future web-research actions. */
export function webSearchActionLabel(actionKind: WebSearchActionKind, active: boolean) {
  switch (actionKind) {
    case 'search':
      return active ? 'Searching web' : 'Searched web'
    case 'open_page':
      return active ? 'Opening page' : 'Opened page'
    case 'find_in_page':
      return active ? 'Searching page' : 'Searched page'
    case 'other':
      return active ? 'Researching web' : 'Web research'
    default: {
      const label = humanizeAction(actionKind)
      return active ? `${label}…` : label
    }
  }
}
