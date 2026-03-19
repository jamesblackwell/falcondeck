import type { ConversationItem, EventEnvelope, ThreadDetail } from './types'
import { normalizeEventEnvelope, normalizeThreadDetail } from './normalization'

export function sortConversationItems(items: ConversationItem[]) {
  return [...items].sort((left, right) => left.created_at.localeCompare(right.created_at))
}

export function conversationItemsForSelection(
  selectedWorkspaceId: string | null,
  selectedThreadId: string | null,
  detail: ThreadDetail | null,
  fallbackItems: ConversationItem[] = [],
): ConversationItem[] {
  if (!selectedThreadId) {
    return []
  }

  // Thread detail can briefly lag behind selection changes, so only trust it
  // when it still belongs to the active workspace/thread pair.
  if (
    detail &&
    detail.workspace.id === selectedWorkspaceId &&
    detail.thread.id === selectedThreadId
  ) {
    return detail.items
  }

  return fallbackItems
}

export function upsertConversationItem(
  items: ConversationItem[],
  next: ConversationItem,
): ConversationItem[] {
  const last = items.at(-1)
  if (!last) {
    return [next]
  }

  // Conversation items are expected to have stable `(kind, id)` identities.
  // Streaming updates usually target the tail item, and new items normally
  // arrive in timestamp order, so handle those hot paths without a scan.
  if (last.id === next.id && last.kind === next.kind) {
    const clone = items.slice()
    clone[clone.length - 1] = next
    const previous = clone.at(-2)
    if (!previous || next.created_at >= previous.created_at) {
      return clone
    }
    return sortConversationItems(clone)
  }

  if (next.created_at >= last.created_at) {
    return [...items, next]
  }

  const index = items.findIndex((item) => item.id === next.id && item.kind === next.kind)
  if (index === -1) {
    return sortConversationItems([...items, next])
  }

  const existing = items[index]
  if (existing.created_at === next.created_at) {
    const clone = items.slice()
    clone[index] = next
    return clone
  }

  const clone = items.slice()
  clone[index] = next
  return sortConversationItems(clone)
}

export function applyEventToThreadDetail(detail: ThreadDetail | null, event: EventEnvelope) {
  const normalizedEvent = normalizeEventEnvelope(event)

  if (!detail || normalizedEvent.thread_id !== detail.thread.id) {
    return detail
  }

  const normalizedDetail = normalizeThreadDetail(detail)

  switch (normalizedEvent.event.type) {
    case 'thread-updated':
      return { ...normalizedDetail, thread: normalizedEvent.event.thread }
    case 'conversation-item-added':
    case 'conversation-item-updated':
      return {
        ...normalizedDetail,
        items: upsertConversationItem(normalizedDetail.items, normalizedEvent.event.item),
      }
    default:
      return normalizedDetail
  }
}
