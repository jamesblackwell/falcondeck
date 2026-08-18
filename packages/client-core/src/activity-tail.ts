import type { ConversationItem, EventEnvelope } from './types'

/* ================================================================
   Activity tails.

   Activity shows a dozen threads at once, so it cannot afford the
   conversation model behind each one: that machinery reconciles full
   transcripts, and running twelve of them per token delta is the one
   way to make a passive dashboard the most expensive view in the app.

   A tail is deliberately less than a transcript. Every conversation
   item collapses to a single line of text and a role, the buffer is
   capped at a handful of lines, and each line is capped in length.
   What survives is what a terminal would have left on screen — enough
   to know what a thread is doing without opening it.
   ================================================================ */

export type ActivityTailRole =
  | 'user'
  | 'agent'
  | 'thinking'
  | 'tool'
  | 'error'
  | 'note'

export type ActivityTailLine = {
  /** The source item's id, so streaming updates land in place. */
  id: string
  role: ActivityTailRole
  text: string
  /** Still being written. The newest streaming line wears the cursor. */
  streaming: boolean
}

export type ActivityTail = {
  lines: ActivityTailLine[]
  /** Whether history has been fetched, as opposed to only observed live. */
  seeded: boolean
}

export const ACTIVITY_TAIL_LINES = 8
/** Long enough for a sentence of context, short enough to stay cheap. */
export const ACTIVITY_TAIL_LINE_CHARS = 320

export const EMPTY_ACTIVITY_TAIL: ActivityTail = { lines: [], seeded: false }

/**
 * Flatten to one line and clamp it, keeping the end rather than the start.
 *
 * Streaming text is the common case here, and holding the head would freeze
 * the readout the moment a long answer passed the cap — the opposite of what
 * a live tail is for. Keeping the end costs the opening words of long items
 * and buys visible movement, which is the whole point.
 *
 * The trailing space survives on purpose. This runs again on every delta, and
 * deltas split mid-sentence: trimming the end would weld the next token onto
 * this one and quietly produce text the agent never wrote.
 */
function clampTailText(text: string) {
  const collapsed = text.replace(/\s+/g, ' ').replace(/^ /, '')
  return collapsed.length > ACTIVITY_TAIL_LINE_CHARS
    ? `…${collapsed.slice(-ACTIVITY_TAIL_LINE_CHARS)}`
    : collapsed
}

function isStreamingLifecycle(lifecycle: string | null | undefined) {
  return lifecycle === 'pending' || lifecycle === 'streaming'
}

function toolLine(
  id: string,
  title: string,
  status: string | null | undefined,
  exitCode: number | null | undefined,
): ActivityTailLine {
  const failed =
    status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0)
  return {
    id,
    role: failed ? 'error' : 'tool',
    text: clampTailText(title),
    streaming: status === 'running' || status === 'queued',
  }
}

/** Collapse one conversation item to the single line a tail can hold. */
export function activityTailLine(item: ConversationItem): ActivityTailLine | null {
  switch (item.kind) {
    case 'user_message':
      return {
        id: item.id,
        role: 'user',
        text: clampTailText(item.text),
        streaming: false,
      }
    case 'assistant_message':
      return {
        id: item.id,
        role: item.error ? 'error' : 'agent',
        text: clampTailText(item.error ?? item.text),
        streaming: isStreamingLifecycle(item.lifecycle),
      }
    case 'reasoning':
      return {
        id: item.id,
        role: 'thinking',
        text: clampTailText(item.summary ?? item.content),
        streaming: isStreamingLifecycle(item.lifecycle),
      }
    case 'tool_call':
      return toolLine(item.id, item.title, item.status, item.exit_code)
    case 'file_change': {
      const paths = item.changes
        .map((change) => change.path)
        .filter(Boolean)
        .slice(0, 3)
      return {
        id: item.id,
        role: 'tool',
        text: clampTailText(
          `edit ${paths.join(' ')}${item.changes.length > paths.length ? ' …' : ''}`,
        ),
        streaming: item.lifecycle === 'running',
      }
    }
    case 'code_review':
      return {
        id: item.id,
        role: 'agent',
        text: clampTailText(item.subject ? `review ${item.subject}` : 'review'),
        streaming: isStreamingLifecycle(item.lifecycle),
      }
    case 'diff':
      return { id: item.id, role: 'tool', text: 'diff', streaming: false }
    case 'plan':
      return {
        id: item.id,
        role: 'note',
        text: clampTailText(
          item.plan.steps.find((step) => step.status !== 'completed')?.step ??
            item.plan.explanation ??
            'plan updated',
        ),
        streaming: false,
      }
    case 'context_compaction':
      return {
        id: item.id,
        role: 'note',
        text: 'compacted context',
        streaming: item.lifecycle === 'running',
      }
    case 'service':
      return {
        id: item.id,
        role: item.level === 'error' ? 'error' : 'note',
        text: clampTailText(item.message),
        streaming: false,
      }
    case 'interactive_request':
      return item.resolved
        ? null
        : {
            id: item.id,
            role: 'note',
            text: clampTailText(item.request.title ?? 'waiting for you'),
            streaming: false,
          }
    case 'image':
      return {
        id: item.id,
        role: 'tool',
        text: clampTailText(item.title ?? 'image'),
        streaming: false,
      }
    case 'web_search':
      return {
        id: item.id,
        role: 'tool',
        text: clampTailText(`search ${item.search.query}`),
        streaming: false,
      }
    // Artifacts, realtime audio, and anything the daemon could not classify
    // carry no one-line summary worth a slot in an eight-line buffer.
    default:
      return null
  }
}

function pushLine(lines: ActivityTailLine[], line: ActivityTailLine) {
  const next = [...lines, line]
  return next.length > ACTIVITY_TAIL_LINES
    ? next.slice(next.length - ACTIVITY_TAIL_LINES)
    : next
}

function upsertLine(tail: ActivityTail, line: ActivityTailLine): ActivityTail {
  const index = tail.lines.findIndex((existing) => existing.id === line.id)
  if (index === -1) return { ...tail, lines: pushLine(tail.lines, line) }
  const existing = tail.lines[index]
  if (
    existing &&
    existing.text === line.text &&
    existing.role === line.role &&
    existing.streaming === line.streaming
  ) {
    return tail
  }
  const lines = [...tail.lines]
  lines[index] = line
  return { ...tail, lines }
}

/** Build a tail from fetched history — the newest items win. */
export function activityTailFromItems(items: ConversationItem[]): ActivityTail {
  const lines: ActivityTailLine[] = []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (lines.length >= ACTIVITY_TAIL_LINES) break
    const item = items[index]
    if (!item) continue
    const line = activityTailLine(item)
    if (line) lines.unshift(line)
  }
  return { lines, seeded: true }
}

/**
 * Fold one event into a tail. Returns the same object when nothing changed so
 * callers can skip re-rendering a card the event did not touch.
 */
export function applyEventToActivityTail(
  tail: ActivityTail,
  event: EventEnvelope,
): ActivityTail {
  switch (event.event.type) {
    case 'conversation-item-added':
    case 'conversation-item-updated': {
      const line = activityTailLine(event.event.item)
      return line ? upsertLine(tail, line) : tail
    }
    case 'text': {
      const { item_id: itemId, delta, target } = event.event
      if (!delta) return tail
      // Tool output streams into the tool's own line; everything else is the
      // agent talking. Reasoning is folded in under its own role so the card
      // can dim it without a second buffer.
      const role: ActivityTailRole =
        target === 'tool_output'
          ? 'tool'
          : target === 'reasoning_summary' || target === 'reasoning_content'
            ? 'thinking'
            : 'agent'
      const index = tail.lines.findIndex((line) => line.id === itemId)
      const previous = index === -1 ? '' : (tail.lines[index]?.text ?? '')
      return upsertLine(tail, {
        id: itemId,
        role: index === -1 ? role : (tail.lines[index]?.role ?? role),
        text: clampTailText(previous + delta),
        streaming: true,
      })
    }
    case 'tool-call-start':
      return upsertLine(
        tail,
        toolLine(event.event.item_id, event.event.title, 'running', null),
      )
    case 'tool-call-end':
      return upsertLine(
        tail,
        toolLine(
          event.event.item_id,
          event.event.title,
          event.event.status,
          event.event.exit_code,
        ),
      )
    case 'turn-end': {
      const settled = tail.lines.some((line) => line.streaming)
        ? {
            ...tail,
            lines: tail.lines.map((line) =>
              line.streaming ? { ...line, streaming: false } : line,
            ),
          }
        : tail
      return event.event.error
        ? upsertLine(settled, {
            id: `${event.event.turn_id}:error`,
            role: 'error',
            text: clampTailText(event.event.error),
            streaming: false,
          })
        : settled
    }
    case 'service':
      // Info chatter is protocol noise; only trouble earns a line.
      return event.event.level === 'info'
        ? tail
        : upsertLine(tail, {
            id: `${event.seq}:service`,
            role: event.event.level === 'error' ? 'error' : 'note',
            text: clampTailText(event.event.message),
            streaming: false,
          })
    default:
      return tail
  }
}

/**
 * A line the client rendered before the daemon echoed it. Sending from a card
 * has to show something immediately, or a send into a busy thread looks lost
 * until the queue drains. The daemon's copy arrives under the same id and
 * replaces this in place.
 */
export function appendOptimisticTailLine(
  tail: ActivityTail,
  id: string,
  text: string,
): ActivityTail {
  return upsertLine(tail, {
    id,
    role: 'user',
    text: clampTailText(text),
    streaming: false,
  })
}
