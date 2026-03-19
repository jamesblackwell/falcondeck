import type {
  ConversationItem,
  EventEnvelope,
  FalconDeckPreferences,
  ThreadDetail,
  ToolDetailsMode,
} from './types'
import { normalizeEventEnvelope, normalizePreferences, normalizeThreadDetail } from './normalization'

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

export type ToolBurstSummary = {
  count: number
  started_at: string
  completed_at: string | null
  labels: string[]
  summary_hint: string | null
}

export type ConversationRenderBlock =
  | {
      kind: 'item'
      id: string
      item: ConversationItem
      default_open: boolean
      suppress_read_only_detail: boolean
    }
  | {
      kind: 'tool_burst'
      id: string
      items: Extract<ConversationItem, { kind: 'tool_call' }>[]
      summary: ToolBurstSummary
      default_open: boolean
      suppress_read_only_detail: boolean
    }

function isToolCall(item: ConversationItem): item is Extract<ConversationItem, { kind: 'tool_call' }> {
  return item.kind === 'tool_call'
}

function isHighSignalTool(
  item: Extract<ConversationItem, { kind: 'tool_call' }>,
  mode: ToolDetailsMode,
  seenDiff: { value: boolean },
  preferences: FalconDeckPreferences,
) {
  if (mode === 'expanded') return true
  if (item.display.is_error && preferences.conversation.auto_expand.errors) return true
  if (item.display.artifact_kind === 'approval_related' && preferences.conversation.auto_expand.approvals) {
    return true
  }
  if (
    item.display.artifact_kind === 'test' &&
    item.display.is_error &&
    preferences.conversation.auto_expand.failed_tests
  ) {
    return true
  }
  if (item.display.artifact_kind === 'diff') {
    const shouldOpen = !seenDiff.value && preferences.conversation.auto_expand.first_diff
    seenDiff.value = true
    return shouldOpen
  }
  return false
}

function isGroupableReadOnlyTool(
  item: ConversationItem,
  preferences: FalconDeckPreferences,
): item is Extract<ConversationItem, { kind: 'tool_call' }> {
  return (
    preferences.conversation.group_read_only_tools &&
    isToolCall(item) &&
    item.display.is_read_only &&
    !item.display.has_side_effect &&
    !item.display.is_error &&
    item.display.artifact_kind === 'none'
  )
}

function shouldSuppressReadOnlyDetail(
  item: ConversationItem,
  mode: ToolDetailsMode,
) {
  return (
    mode === 'hide_read_only_details' &&
    isToolCall(item) &&
    item.display.is_read_only &&
    !item.display.has_side_effect &&
    !item.display.is_error
  )
}

function buildToolBurstSummary(
  items: Extract<ConversationItem, { kind: 'tool_call' }>[],
): ToolBurstSummary {
  const labels: string[] = []
  for (const item of items) {
    const label = item.display.summary_hint ?? item.title
    if (!labels.includes(label)) labels.push(label)
    if (labels.length >= 2) break
  }

  return {
    count: items.length,
    started_at: items[0]?.created_at ?? new Date(0).toISOString(),
    completed_at: items[items.length - 1]?.completed_at ?? null,
    labels,
    summary_hint: items.find((item) => item.display.summary_hint)?.display.summary_hint ?? null,
  }
}

export function deriveConversationRenderBlocks(
  items: ConversationItem[],
  preferencesInput: FalconDeckPreferences | null | undefined,
): ConversationRenderBlock[] {
  const preferences = normalizePreferences(preferencesInput)
  const blocks: ConversationRenderBlock[] = []
  const seenDiff = { value: false }
  const mode = preferences.conversation.tool_details_mode

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]

    if (isGroupableReadOnlyTool(item, preferences)) {
      const burstItems: Extract<ConversationItem, { kind: 'tool_call' }>[] = [item]
      let nextIndex = index + 1
      while (nextIndex < items.length) {
        const nextItem = items[nextIndex]
        if (!nextItem || !isGroupableReadOnlyTool(nextItem, preferences)) {
          break
        }
        burstItems.push(nextItem)
        nextIndex += 1
      }

      blocks.push({
        kind: 'tool_burst',
        id: `tool-burst:${burstItems[0]!.id}:${burstItems.length}`,
        items: burstItems,
        summary: buildToolBurstSummary(burstItems),
        default_open: mode === 'expanded',
        suppress_read_only_detail: mode === 'hide_read_only_details',
      })
      index = nextIndex - 1
      continue
    }

    let defaultOpen = false
    if (isToolCall(item)) {
      defaultOpen = isHighSignalTool(item, mode, seenDiff, preferences)
    } else if (item.kind === 'diff') {
      defaultOpen = !seenDiff.value && preferences.conversation.auto_expand.first_diff
      seenDiff.value = true
    }
    const suppressReadOnlyDetail = shouldSuppressReadOnlyDetail(item, mode)

    blocks.push({
      kind: 'item',
      id: `${item.kind}:${item.id}`,
      item,
      default_open: defaultOpen,
      suppress_read_only_detail: suppressReadOnlyDetail,
    })
  }

  return blocks
}
