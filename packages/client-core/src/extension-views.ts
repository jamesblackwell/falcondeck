import type { ExtensionSnapshot, ExtensionView } from './types'

export const THREAD_TAGS_EXTENSION_ID = 'falcondeck.thread-tags'
export const THREAD_TAGS_ACTION_ID = 'manage-tags'

export type ThreadStageIcon =
  | 'backlog'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'canceled'
  | 'custom'

export type ThreadTag = {
  id: string
  label: string
  color: string
  icon?: ThreadStageIcon | string
}

export type ThreadTagsProjection = {
  tags: ThreadTag[]
  byThreadId: Record<string, ThreadTag[]>
}

export const DEFAULT_THREAD_STAGES: ThreadTag[] = [
  { id: 'backlog', label: 'Backlog', color: 'gray', icon: 'backlog' },
  { id: 'in_progress', label: 'In progress', color: 'yellow', icon: 'in_progress' },
  { id: 'in_review', label: 'In review', color: 'green', icon: 'in_review' },
  { id: 'done', label: 'Done', color: 'orange', icon: 'done' },
  { id: 'canceled', label: 'Canceled', color: 'gray', icon: 'canceled' },
]

export function isThreadStageId(id: string): boolean {
  return DEFAULT_THREAD_STAGES.some(stage => stage.id === id)
}

const LEGACY_COLOR_IDS = new Set([
  'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink',
])

function isThreadTag(value: unknown): value is ThreadTag {
  if (!value || typeof value !== 'object') return false
  const tag = value as Partial<ThreadTag>
  return typeof tag.id === 'string' && typeof tag.label === 'string' && typeof tag.color === 'string'
}

function looksLikeLegacyColorPalette(tags: ThreadTag[]): boolean {
  return tags.length === LEGACY_COLOR_IDS.size && tags.every(tag => LEGACY_COLOR_IDS.has(tag.id))
}

function viewValue(view: ExtensionView | undefined): Record<string, unknown> {
  return view?.value && typeof view.value === 'object'
    ? view.value as Record<string, unknown>
    : {}
}

/**
 * Adapts the official Kanban extension's public stage projections for clients.
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
  const tags = publishedTags.length > 0 && !looksLikeLegacyColorPalette(publishedTags)
    ? publishedTags
    : DEFAULT_THREAD_STAGES
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

/** Applies the immediate local result of a Kanban stage selection. */
export function optimisticallySetThreadStage(
  extensions: ExtensionSnapshot,
  threadId: string,
  stageId: string | null,
): ExtensionSnapshot {
  const matchesThreadStage = (view: ExtensionView) =>
    view.extension_id === THREAD_TAGS_EXTENSION_ID &&
    view.view_id === 'thread-tags' &&
    view.scope?.kind === 'thread' &&
    view.scope.id === threadId
  const views = extensions.views.filter(view => !matchesThreadStage(view))
  views.push({
    extension_id: THREAD_TAGS_EXTENSION_ID,
    view_id: 'thread-tags',
    scope: { kind: 'thread', id: threadId },
    value: { tagIds: stageId ? [stageId] : [] },
    updated_at: new Date().toISOString(),
  })
  return { ...extensions, views }
}
