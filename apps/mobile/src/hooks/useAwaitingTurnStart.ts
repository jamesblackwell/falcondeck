import { useCallback, useEffect, useState } from 'react'

/** Longest an accepted send may look busy before the agent reports in. */
export const AWAITING_TURN_START_MS = 45_000

/**
 * Bridges the gap between the daemon accepting a turn and the thread
 * reporting `running`. An ACP agent can take several seconds to spin up, and
 * until then the transcript showed the user's message and nothing else —
 * which reads as a send that went nowhere.
 *
 * `markAccepted` is called once a send is accepted. The flag clears as soon as
 * the thread reports any non-idle status, after a timeout, or when the reader
 * opens a different existing thread. A new conversation gaining its first
 * thread id counts as the same conversation.
 */
export function useAwaitingTurnStart(threadId: string | null, status: string | null) {
  const [awaiting, setAwaiting] = useState<{ threadId: string | null } | null>(null)

  const markAccepted = useCallback(() => {
    setAwaiting({ threadId })
  }, [threadId])

  useEffect(() => {
    if (!awaiting) return
    const timer = setTimeout(() => setAwaiting(null), AWAITING_TURN_START_MS)
    return () => clearTimeout(timer)
  }, [awaiting])

  const isSameConversation =
    awaiting !== null && (awaiting.threadId === null || awaiting.threadId === threadId)
  const started = status !== null && status !== 'idle'

  useEffect(() => {
    if (awaiting && isSameConversation && started) setAwaiting(null)
  }, [awaiting, isSameConversation, started])

  return { isAwaiting: isSameConversation && !started, markAccepted }
}
