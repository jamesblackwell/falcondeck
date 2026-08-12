import type { ExtensionSnapshot, ExtensionView } from './types'

export const THREAD_TAGS_EXTENSION_ID = 'falcondeck.thread-tags'
export const THREAD_TAGS_ACTION_ID = 'manage-tags'

export type ThreadTag = {
  id: string
  label: string
  color: string
}

export type ThreadTagsProjection = {
  tags: ThreadTag[]
  byThreadId: Record<string, ThreadTag[]>
}

const THREAD_COLOR_PALETTE: ThreadTag[] = [
  'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink',
].map(color => ({
  id: color,
  label: color[0]!.toUpperCase() + color.slice(1),
  color,
}))

function isThreadTag(value: unknown): value is ThreadTag {
  if (!value || typeof value !== 'object') return false
  const tag = value as Partial<ThreadTag>
  return typeof tag.id === 'string' && typeof tag.label === 'string' && typeof tag.color === 'string'
}

function viewValue(view: ExtensionView | undefined): Record<string, unknown> {
  return view?.value && typeof view.value === 'object'
    ? view.value as Record<string, unknown>
    : {}
}

/**
 * Adapts the official Thread Colours extension's public projections for clients.
 * It intentionally consumes only ExtensionSnapshot, so desktop, web, and mobile
 * share the same compatibility and malformed-data behaviour.
 */
export function deriveThreadTags(extensions: ExtensionSnapshot | null | undefined): ThreadTagsProjection {
  const active = extensions?.catalog.some(
    extension => extension.id === THREAD_TAGS_EXTENSION_ID && extension.enabled,
  ) ?? false
  if (!active) return { tags: [], byThreadId: {} }

  const tagIndex = extensions?.views.find(
    view => view.extension_id === THREAD_TAGS_EXTENSION_ID && view.view_id === 'tag-index',
  )
  const rawTags = viewValue(tagIndex).tags
  const publishedTags = Array.isArray(rawTags) ? rawTags.filter(isThreadTag) : []
  const tags = publishedTags.length === THREAD_COLOR_PALETTE.length &&
    publishedTags.every(tag => THREAD_COLOR_PALETTE.some(color => color.id === tag.id))
    ? publishedTags
    : THREAD_COLOR_PALETTE
  const tagsById = new Map(tags.map(tag => [tag.id, tag]))
  const byThreadId: Record<string, ThreadTag[]> = {}

  for (const view of extensions?.views ?? []) {
    if (
      view.extension_id !== THREAD_TAGS_EXTENSION_ID ||
      view.view_id !== 'thread-tags' ||
      view.scope?.kind !== 'thread'
    ) continue
    const rawTagIds = viewValue(view).tagIds
    if (!Array.isArray(rawTagIds)) continue
    byThreadId[view.scope.id] = rawTagIds.flatMap(id => {
      const tag = typeof id === 'string' ? tagsById.get(id) : undefined
      return tag ? [tag] : []
    })
  }

  return { tags, byThreadId }
}

/** Applies the immediate local result of a Thread Colours selection. */
export function optimisticallySetThreadColor(
  extensions: ExtensionSnapshot,
  threadId: string,
  color: string | null,
): ExtensionSnapshot {
  const matchesThreadColor = (view: ExtensionView) =>
    view.extension_id === THREAD_TAGS_EXTENSION_ID &&
    view.view_id === 'thread-tags' &&
    view.scope?.kind === 'thread' &&
    view.scope.id === threadId
  const views = extensions.views.filter(view => !matchesThreadColor(view))
  views.push({
    extension_id: THREAD_TAGS_EXTENSION_ID,
    view_id: 'thread-tags',
    scope: { kind: 'thread', id: threadId },
    value: { tagIds: color ? [color] : [] },
    updated_at: new Date().toISOString(),
  })
  return { ...extensions, views }
}
