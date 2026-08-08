import type {
  ConversationItem,
  EventEnvelope,
  FalconDeckPreferences,
  ThreadDetail,
  ToolActivityKind,
  ToolDetailsMode,
} from './types'
import {
  normalizeConversationItem,
  normalizeEventEnvelope,
  normalizePreferences,
  normalizeThreadDetail,
} from './normalization'

export function sortConversationItems(items: ConversationItem[]) {
  // Plain code-unit comparison: created_at values are uniform ISO-8601 strings
  // (same UTC offset and precision from the daemon), so lexicographic order is
  // chronological order and ICU collation is unnecessary on this hot path.
  return [...items].sort((left, right) =>
    left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : 0,
  )
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

  if (next.created_at > last.created_at) {
    return [...items, next]
  }

  // Provider timestamps are often second-precision, so an update to an
  // earlier item can tie the tail's created_at; only take the append fast
  // path when the item cannot already exist earlier in the list. The list is
  // sorted, so items tying the tail's timestamp cluster at the tail — scan
  // backwards and bail at the first older timestamp instead of scanning the
  // whole list.
  if (next.created_at === last.created_at) {
    let existsInTailTie = false
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.created_at !== next.created_at) break
      if (item.id === next.id && item.kind === next.kind) {
        existsInTailTie = true
        break
      }
    }
    if (!existsInTailTie) {
      return [...items, next]
    }
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
  if (!detail) {
    return detail
  }

  // Only normalize (and reallocate) the detail on branches that actually
  // mutate it. Events this function does not handle — including per-token
  // `text` deltas — must return the original reference unchanged so callers
  // can skip re-rendering.
  const normalizedEvent = normalizeEventEnvelope(event)

  if (
    normalizedEvent.event.type === 'workspace-updated' &&
    normalizedEvent.workspace_id === detail.workspace.id
  ) {
    return { ...normalizeThreadDetail(detail), workspace: normalizedEvent.event.workspace }
  }

  if (normalizedEvent.thread_id !== detail.thread.id) {
    return detail
  }

  switch (normalizedEvent.event.type) {
    case 'thread-updated':
      return { ...normalizeThreadDetail(detail), thread: normalizedEvent.event.thread }
    case 'conversation-item-added':
    case 'conversation-item-updated': {
      // Only the incoming item is normalized. Re-normalizing the whole detail
      // here would rebuild every item object on every streaming delta, which
      // breaks referential equality for items that did not change — defeating
      // memoized message rendering and making long threads visibly stutter as
      // tokens arrive. Details are normalized when fetched (daemon-client and
      // the remote-host client both do it), and every branch here preserves
      // that, so the array is already in normalized form.
      const items = upsertConversationItem(
        detail.items,
        normalizeConversationItem(normalizedEvent.event.item),
      )
      return {
        ...detail,
        items,
        oldest_item_id: items[0]?.id ?? detail.oldest_item_id,
        newest_item_id: items.at(-1)?.id ?? detail.newest_item_id,
      }
    }
    default:
      return detail
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
  | {
      /** One contiguous run of tool work, hidden behind a single line
          ("Working…" / "Worked for 2m 14s") in the collapsed mode. */
      kind: 'work_session'
      id: string
      items: WorkSessionEntry[]
      running: boolean
      started_at: string
      completed_at: string | null
    }

/**
 * What a buried work run can contain. Reasoning rides along with the tool calls
 * it interleaves with so expanding the run reveals the agent's thinking in
 * order — emitting it as its own top-level block instead would shatter one
 * "Worked for 2m" into a column of one-second rows, because providers tend to
 * emit a thought between every pair of tool calls.
 */
export type WorkSessionEntry =
  | Extract<ConversationItem, { kind: 'tool_call' }>
  | Extract<ConversationItem, { kind: 'reasoning' }>

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

export type ConversationPresentationOptions = {
  /** True while the agent's turn is still streaming. A trailing thought keeps
      its work session alive so a running thread can never render as settled. */
  is_streaming?: boolean
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

/** "Worked for 2m 14s"-style duration between two ISO timestamps. */
export function formatWorkDuration(startedAt: string, completedAt: string): string {
  const seconds = Math.max(1, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function deriveConversationPresentation(
  items: ConversationItem[],
  preferencesInput: FalconDeckPreferences | null | undefined,
  options: ConversationPresentationOptions = {},
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

  // ChatGPT-style default: bury contiguous tool runs behind one line. Only
  // approvals, diffs, errors, and failed tests break out of the fold.
  if (mode === 'collapsed') {
    let workBuffer: WorkSessionEntry[] = []
    // Receipts (resolved approvals, service notices) gathered during a run.
    // They render as quiet rows after the run they belong to, so they never
    // interrupt the fold.
    let buriedReceipts: ConversationItem[] = []
    const flushReceipts = () => {
      for (const receipt of buriedReceipts) {
        historyBlocks.push({
          kind: 'item',
          id: `${receipt.kind}:${receipt.id}`,
          item: receipt,
          default_open: false,
          suppress_read_only_detail: false,
        })
      }
      buriedReceipts = []
    }
    const flushWork = () => {
      if (workBuffer.length === 0) {
        flushReceipts()
        return
      }
      const running = workBuffer.some(
        (entry) => entry.kind === 'tool_call' && isRunningToolStatus(entry.status),
      )
      const last = workBuffer[workBuffer.length - 1]!
      historyBlocks.push({
        kind: 'work_session',
        // Keyed by the first item only: these ids are React keys, and folding
        // the running count in would change the key every time a tool joins
        // the session, remounting the whole card mid-stream (visible flash,
        // and its expand state resets).
        id: `work:${workBuffer[0]!.id}`,
        items: workBuffer,
        running,
        started_at: workBuffer[0]!.created_at,
        completed_at: running
          ? null
          : (last.kind === 'tool_call' ? last.completed_at : null) ?? last.created_at,
      })
      workBuffer = []
      flushReceipts()
    }

    for (const item of items) {
      // Reasoning is part of the buried work; don't let it split a run. It
      // joins the open run so expanding reveals it in order, but a thought
      // with no work around it still gets its own block — otherwise it would
      // be labelled "Worked for 1s" when no work happened at all.
      if (item.kind === 'reasoning') {
        if (workBuffer.length > 0) {
          workBuffer.push(item)
          continue
        }
        flushReceipts()
        historyBlocks.push({
          kind: 'item',
          id: `${item.kind}:${item.id}`,
          item,
          default_open: false,
          suppress_read_only_detail: false,
        })
        continue
      }
      // Neither do the receipts that accompany work: resolved approvals and
      // service notices. Rendering them between fragments is what turned one
      // "Worked for 2m" into a column of "Worked for 1s" rows.
      if (item.kind === 'interactive_request' && item.resolved) {
        buriedReceipts.push(item)
        continue
      }
      if (item.kind === 'service') {
        buriedReceipts.push(item)
        continue
      }
      if (isToolCall(item)) {
        const mustSurface =
          (item.display.is_error && preferences.conversation.auto_expand.errors) ||
          (item.display.artifact_kind === 'approval_related' &&
            preferences.conversation.auto_expand.approvals) ||
          item.display.artifact_kind === 'diff' ||
          (item.display.artifact_kind === 'test' && item.display.is_error)
        if (!mustSurface) {
          workBuffer.push(item)
          continue
        }
      }
      flushWork()
      let defaultOpen = false
      if (isToolCall(item)) {
        defaultOpen = isHighSignalTool(item, mode, seenDiff, preferences)
      } else if (item.kind === 'diff') {
        defaultOpen = !seenDiff.value && preferences.conversation.auto_expand.first_diff
        seenDiff.value = true
      }
      historyBlocks.push({
        kind: 'item',
        id: `${item.kind}:${item.id}`,
        item,
        default_open: defaultOpen,
        suppress_read_only_detail: shouldSuppressReadOnlyDetail(item, mode),
      })
    }
    flushWork()

    // A turn that is mid-thought after its tools settled must keep its work
    // session live. Without this the session collapses to "Worked for 43s"
    // with the streaming thought buried inside it, and the conversation's
    // standalone "Thinking…" line is suppressed because a reasoning item is
    // the newest item — a running thread rendering zero indicators.
    if (options.is_streaming) {
      const tail = historyBlocks[historyBlocks.length - 1]
      if (
        tail?.kind === 'work_session' &&
        !tail.running &&
        tail.items[tail.items.length - 1]?.kind === 'reasoning'
      ) {
        tail.running = true
        tail.completed_at = null
      }
    }

    // Running work renders as its own "Working…" block, so the pinned live
    // lane stays empty in this mode.
    return {
      live_activity_groups: [],
      history_blocks: historyBlocks,
    }
  }

  const flushSummaryBuffer = () => {
    if (summaryBuffer.length === 0 || !summaryFamily) return
    historyBlocks.push({
      kind: 'tool_summary',
      id: `tool-summary:${summaryBuffer[0]!.id}`,
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
      id: `live-activity:${liveBuffer[0]!.id}`,
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
  options: ConversationPresentationOptions = {},
): ConversationRenderBlock[] {
  return deriveConversationPresentation(items, preferencesInput, options).history_blocks
}
