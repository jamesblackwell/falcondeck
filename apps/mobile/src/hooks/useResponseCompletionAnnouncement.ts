import { useEffect, useRef } from 'react'
import type { AppStateStatus } from 'react-native'

import {
  advanceResponseCompletionTracker,
  type ConversationItem,
  type ResponseCompletionTrackerState,
} from '@falcondeck/client-core'

import { announceAgentCompletion } from '@/lib/accessibility'

export function useResponseCompletionAnnouncement({
  threadKey,
  status,
  items,
  appState,
  onComplete = announceAgentCompletion,
}: {
  threadKey: string | null
  status: string | null
  items: ConversationItem[]
  appState: AppStateStatus
  onComplete?: () => void
}) {
  const trackerRef = useRef<ResponseCompletionTrackerState | null>(null)
  const foregroundRef = useRef(false)

  useEffect(() => {
    const previous = trackerRef.current
    const result = advanceResponseCompletionTracker(previous, {
      threadKey,
      busy: status === 'running',
      ready: status === 'idle',
      items,
    })
    trackerRef.current = result.state

    if (!previous || previous.threadKey !== threadKey) {
      foregroundRef.current = status === 'running' && appState === 'active'
    } else if (!previous.wasBusy && status === 'running') {
      foregroundRef.current = appState === 'active'
    } else if (appState !== 'active' && result.state.awaitingCompletion) {
      foregroundRef.current = false
    }

    if (result.completed) {
      if (foregroundRef.current && appState === 'active') {
        onComplete()
      }
      foregroundRef.current = false
    }
  }, [appState, items, onComplete, status, threadKey])
}
