import { useEffect, useRef } from 'react'

import type { ThreadSummary } from '@falcondeck/client-core'

import { consumeAutoReadSuppression, useThreadActions } from './useThreadActions'

const AUTO_MARK_READ_DEBOUNCE_MS = 1_000

/**
 * Opening a thread should clear its unread state. Desktop does this over
 * `thread.mark_read` RPC and applies the returned summary immediately.
 * Mobile used to POST a fire-and-forget relay action and then record the
 * seq as sent before the request even finished — a failed or unapplied
 * action left the thread unread forever.
 */
export function useAutoMarkThreadRead({
  appState,
  isEncrypted,
  workspaceId,
  thread,
}: {
  appState: string
  isEncrypted: boolean
  workspaceId: string | null | undefined
  thread: ThreadSummary | null
}) {
  const { markThreadRead } = useThreadActions()
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSentReadSeqRef = useRef<{
    threadId: string
    readSeq: number
  } | null>(null)

  const threadId = thread?.id ?? null
  const activitySeq = thread?.attention.last_agent_activity_seq ?? 0
  const lastReadSeq = thread?.attention.last_read_seq ?? 0

  useEffect(() => {
    if (appState !== 'active' || !workspaceId || !threadId || !isEncrypted) return

    const readSeq = activitySeq
    if (!readSeq || readSeq <= lastReadSeq) return

    // A thread the user just marked unread is skipped until they leave it or
    // the agent posts something new. On release the dedupe below has to go too
    // — it still holds this exact seq from when the thread was last read, and
    // would otherwise keep the auto-read from ever firing again.
    const suppression = consumeAutoReadSuppression(threadId, readSeq)
    if (suppression === 'suppress') return
    if (suppression === 'released') lastSentReadSeqRef.current = null

    const lastSent = lastSentReadSeqRef.current
    if (lastSent && lastSent.threadId === threadId && lastSent.readSeq >= readSeq) {
      return
    }

    markReadTimerRef.current = setTimeout(() => {
      markReadTimerRef.current = null
      void markThreadRead(workspaceId, threadId, readSeq)
        .then(() => {
          lastSentReadSeqRef.current = { threadId, readSeq }
        })
        .catch(() => {})
    }, AUTO_MARK_READ_DEBOUNCE_MS)

    return () => {
      if (markReadTimerRef.current) {
        clearTimeout(markReadTimerRef.current)
        markReadTimerRef.current = null
      }
    }
  }, [
    activitySeq,
    appState,
    isEncrypted,
    lastReadSeq,
    markThreadRead,
    threadId,
    workspaceId,
  ])
}
