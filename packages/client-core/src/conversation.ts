import type {
  ConversationItem,
  EventEnvelope,
  FalconDeckPreferences,
  ThreadDetail,
  ToolActivityKind,
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
  if (!detail) {
    return detail
  }

  const normalizedDetail = normalizeThreadDetail(detail)

  if (
    normalizedEvent.event.type === 'workspace-updated' &&
    normalizedEvent.workspace_id === normalizedDetail.workspace.id
  ) {
    return { ...normalizedDetail, workspace: normalizedEvent.event.workspace }
  }

  if (normalizedEvent.thread_id !== normalizedDetail.thread.id) {
    return detail
  }

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

export type ToolActivityFamily = 'explore' | 'command'

export type ToolActivitySummary = {
  family: ToolActivityFamily
  count: number
  started_at: string
  completed_at: string | null
  title: string
  subtitle: string | null
  labels: string[]
  counts: Partial<Record<ToolActivityKind, number>>
  summary_hint: string | null
}

export type ConversationHistoryBlock =
  | {
      kind: 'item'
      id: string
      item: ConversationItem
      default_open: boolean
      suppress_read_only_detail: boolean
    }
  | {
      kind: 'tool_summary'
      id: string
      items: Extract<ConversationItem, { kind: 'tool_call' }>[]
      summary: ToolActivitySummary
      default_open: boolean
      suppress_read_only_detail: boolean
    }

export type ConversationRenderBlock = ConversationHistoryBlock

export type ConversationLiveActivityGroup = {
  kind: 'live_activity_group'
  id: string
  items: Extract<ConversationItem, { kind: 'tool_call' }>[]
  summary: ToolActivitySummary
}

export type ConversationPresentation = {
  live_activity_groups: ConversationLiveActivityGroup[]
  history_blocks: ConversationHistoryBlock[]
}

function isToolCall(item: ConversationItem): item is Extract<ConversationItem, { kind: 'tool_call' }> {
  return item.kind === 'tool_call'
}

function isRunningToolStatus(status: string) {
  return status === 'running' || status === 'in_progress'
}

function toolActivityFamily(
  item: Extract<ConversationItem, { kind: 'tool_call' }>,
): ToolActivityFamily | null {
  switch (item.display.activity_kind) {
    case 'command':
      return 'command'
    case 'read':
    case 'search':
    case 'list':
    case 'web_search':
    case 'image_view':
    case 'context':
      return 'explore'
    default:
      return null
  }
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

function isSummarizableTool(
  item: Extract<ConversationItem, { kind: 'tool_call' }>,
  preferences: FalconDeckPreferences,
): boolean {
  return (
    preferences.conversation.group_read_only_tools &&
    item.display.history_mode === 'summary' &&
    !item.display.is_error &&
    toolActivityFamily(item) !== null
  )
}

function shouldSuppressReadOnlyDetail(
  item: ConversationItem,
  mode: ToolDetailsMode,
) {
  return (
    (mode === 'hide_read_only_details' || mode === 'compact') &&
    isToolCall(item) &&
    item.display.is_read_only &&
    !item.display.has_side_effect &&
    !item.display.is_error
  )
}

function incrementCount(
  counts: Partial<Record<ToolActivityKind, number>>,
  key: ToolActivityKind,
) {
  counts[key] = (counts[key] ?? 0) + 1
}

function countLabel(kind: ToolActivityKind, count: number) {
  switch (kind) {
    case 'read':
      return `${count} file${count === 1 ? '' : 's'}`
    case 'search':
      return `${count} search${count === 1 ? '' : 'es'}`
    case 'list':
      return `${count} list${count === 1 ? '' : 's'}`
    case 'web_search':
      return `${count} web search${count === 1 ? '' : 'es'}`
    case 'image_view':
      return `${count} image${count === 1 ? '' : 's'}`
    case 'context':
      return `${count} context step${count === 1 ? '' : 's'}`
    case 'command':
      return `${count} command${count === 1 ? '' : 's'}`
    default:
      return `${count} tool${count === 1 ? '' : 's'}`
  }
}

function orderedCountLabels(
  counts: Partial<Record<ToolActivityKind, number>>,
  family: ToolActivityFamily,
) {
  const order: ToolActivityKind[] =
    family === 'command'
      ? ['command']
      : ['read', 'search', 'list', 'web_search', 'image_view', 'context']

  return order
    .map((kind) => {
      const count = counts[kind]
      return typeof count === 'number' && count > 0 ? countLabel(kind, count) : null
    })
    .filter((label): label is string => Boolean(label))
}

function buildToolActivitySummary(
  items: Extract<ConversationItem, { kind: 'tool_call' }>[],
  family: ToolActivityFamily,
  tense: 'live' | 'history',
): ToolActivitySummary {
  const labels: string[] = []
  const counts: Partial<Record<ToolActivityKind, number>> = {}
  for (const item of items) {
    incrementCount(counts, item.display.activity_kind)
    const label = item.display.summary_hint ?? item.title
    if (!labels.includes(label)) labels.push(label)
    if (labels.length >= 2) break
  }
  const countLabels = orderedCountLabels(counts, family)
  const title =
    tense === 'live'
      ? family === 'command'
        ? `Running ${countLabels[0] ?? countLabel('command', items.length)}`
        : `Exploring ${countLabels[0] ?? `${items.length} item${items.length === 1 ? '' : 's'}`}`
      : family === 'command'
        ? `Ran ${countLabels.join(', ') || countLabel('command', items.length)}`
        : `Explored ${countLabels.join(', ') || `${items.length} item${items.length === 1 ? '' : 's'}`}`

  return {
    family,
    count: items.length,
    started_at: items[0]?.created_at ?? new Date(0).toISOString(),
    completed_at: items[items.length - 1]?.completed_at ?? null,
    title,
    subtitle: labels.join(' · ') || null,
    labels,
    counts,
    summary_hint: items.find((item) => item.display.summary_hint)?.display.summary_hint ?? null,
  }
}

export function deriveConversationPresentation(
  items: ConversationItem[],
  preferencesInput: FalconDeckPreferences | null | undefined,
): ConversationPresentation {
  const preferences = normalizePreferences(preferencesInput)
  const historyBlocks: ConversationHistoryBlock[] = []
  const liveActivityGroups: ConversationLiveActivityGroup[] = []
  const seenDiff = { value: false }
  const mode = preferences.conversation.tool_details_mode
  let summaryBuffer: Extract<ConversationItem, { kind: 'tool_call' }>[] = []
  let summaryFamily: ToolActivityFamily | null = null
  let liveBuffer: Extract<ConversationItem, { kind: 'tool_call' }>[] = []
  let liveFamily: ToolActivityFamily | null = null

  const suppressReadOnlyDetail = mode === 'hide_read_only_details' || mode === 'compact'

  const flushSummaryBuffer = () => {
    if (summaryBuffer.length === 0 || !summaryFamily) return
    historyBlocks.push({
      kind: 'tool_summary',
      id: `tool-summary:${summaryBuffer[0]!.id}:${summaryBuffer.length}`,
      items: summaryBuffer,
      summary: buildToolActivitySummary(summaryBuffer, summaryFamily, 'history'),
      default_open: mode === 'expanded',
      suppress_read_only_detail: suppressReadOnlyDetail,
    })
    summaryBuffer = []
    summaryFamily = null
  }

  const flushLiveBuffer = () => {
    if (liveBuffer.length === 0 || !liveFamily) return
    liveActivityGroups.push({
      kind: 'live_activity_group',
      id: `live-activity:${liveBuffer[0]!.id}:${liveBuffer.length}`,
      items: liveBuffer,
      summary: buildToolActivitySummary(liveBuffer, liveFamily, 'live'),
    })
    liveBuffer = []
    liveFamily = null
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]

    if (isToolCall(item) && isSummarizableTool(item, preferences)) {
      const family = toolActivityFamily(item)
      if (family) {
        if (isRunningToolStatus(item.status)) {
          flushSummaryBuffer()
          if (liveFamily && liveFamily !== family) {
            flushLiveBuffer()
          }
          liveFamily = family
          liveBuffer.push(item)
          continue
        }

        flushLiveBuffer()
        if (summaryFamily && summaryFamily !== family) {
          flushSummaryBuffer()
        }
        summaryFamily = family
        summaryBuffer.push(item)
        continue
      }
    }

    flushSummaryBuffer()
    flushLiveBuffer()

    let defaultOpen = false
    if (isToolCall(item)) {
      defaultOpen = isHighSignalTool(item, mode, seenDiff, preferences)
    } else if (item.kind === 'diff') {
      defaultOpen = !seenDiff.value && preferences.conversation.auto_expand.first_diff
      seenDiff.value = true
    }
    const itemSuppressReadOnlyDetail = shouldSuppressReadOnlyDetail(item, mode)

    historyBlocks.push({
      kind: 'item',
      id: `${item.kind}:${item.id}`,
      item,
      default_open: defaultOpen,
      suppress_read_only_detail: itemSuppressReadOnlyDetail,
    })
  }

  flushSummaryBuffer()
  flushLiveBuffer()

  return {
    live_activity_groups: liveActivityGroups,
    history_blocks: historyBlocks,
  }
}

export function deriveConversationRenderBlocks(
  items: ConversationItem[],
  preferencesInput: FalconDeckPreferences | null | undefined,
): ConversationRenderBlock[] {
  return deriveConversationPresentation(items, preferencesInput).history_blocks
}
