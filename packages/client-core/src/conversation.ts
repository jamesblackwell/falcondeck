import type { ConversationItem, EventEnvelope, ThreadDetail } from './types'

export function sortConversationItems(items: ConversationItem[]) {
  return [...items].sort((left, right) => left.created_at.localeCompare(right.created_at))
}

export function upsertConversationItem(
  items: ConversationItem[],
  next: ConversationItem,
): ConversationItem[] {
  const index = items.findIndex((item) => item.id === next.id && item.kind === next.kind)
  if (index === -1) {
    return sortConversationItems([...items, next])
  }
  const clone = items.slice()
  clone[index] = next
  return sortConversationItems(clone)
}

export function applyEventToThreadDetail(detail: ThreadDetail | null, event: EventEnvelope) {
  if (!detail || event.thread_id !== detail.thread.id) {
    return detail
  }

  switch (event.event.type) {
    case 'thread-updated':
      return { ...detail, thread: event.event.thread }
    case 'conversation-item-added':
    case 'conversation-item-updated':
      return {
        ...detail,
        items: upsertConversationItem(detail.items, event.event.item),
      }
    default:
      return detail
  }
}

