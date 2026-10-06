import type { ConversationItem, DaemonSnapshot, QueuedTurnSummary } from '@falcondeck/client-core'

export type MobileQueuedTurn = QueuedTurnSummary & { pending?: boolean }

export interface PendingQueuedTurn {
  turn: MobileQueuedTurn
  knownQueuedIds: string[]
}

export type PendingQueuedTurns = Record<string, PendingQueuedTurn[]>

function matchesQueuedTurn(queued: QueuedTurnSummary, pending: MobileQueuedTurn) {
  const sameText = queued.text !== undefined
    ? queued.text.trim() === pending.text
    : queued.preview === pending.preview
  return sameText && (queued.attachment_count === undefined || queued.attachment_count === pending.attachment_count)
}

/** The daemon assigns queue ids, so match new rows against the queue seen at
 * send time. Keep local rows through unrelated updates and remove them only
 * when the queue or transcript echoes the send. Nothing here is persisted. */
export function reconcilePendingQueuedTurns(
  pendingByThread: PendingQueuedTurns,
  snapshot: DaemonSnapshot | null,
  threadItems: Record<string, ConversationItem[]>,
): PendingQueuedTurns {
  let result = pendingByThread
  for (const [threadId, pending] of Object.entries(pendingByThread)) {
    const thread = snapshot?.threads.find((entry) => entry.id === threadId)
    const claimedIds = new Set<string>()
    let remaining = pending.filter(({ turn, knownQueuedIds }) => {
      if (snapshot && !thread) return false
      const echoed = threadItems[threadId]?.some((item) =>
        item.kind === 'user_message' && item.id === turn.id && !item.pending,
      )
      const queued = thread?.queued_turns.find((entry) =>
        !knownQueuedIds.includes(entry.id) && !claimedIds.has(entry.id) && matchesQueuedTurn(entry, turn),
      )
      if (queued) claimedIds.add(queued.id)
      return !echoed && !queued
    })
    if (remaining.length === pending.length) continue
    // Two identical sends can both be awaiting events. Once one echo has
    // claimed a row, the other send must not claim it in a later event batch.
    if (claimedIds.size > 0) {
      remaining = remaining.map((entry) => ({
        ...entry,
        knownQueuedIds: [...new Set([...entry.knownQueuedIds, ...claimedIds])],
      }))
    }
    if (result === pendingByThread) result = { ...pendingByThread }
    if (remaining.length > 0) result[threadId] = remaining
    else delete result[threadId]
  }
  return result
}
