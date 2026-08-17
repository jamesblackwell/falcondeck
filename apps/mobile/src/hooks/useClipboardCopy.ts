import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo } from 'react-native'
import * as Clipboard from 'expo-clipboard'

export type ClipboardCopyResult = 'idle' | 'copied' | 'failed'

const FEEDBACK_DURATION_MS = 1_500

/**
 * Makes clipboard writes truthful: confirmation appears only after the native
 * write resolves, failures remain retryable, and stale completions cannot
 * update an unmounted or superseded action.
 */
export function useClipboardCopy(
  text: string,
  successAnnouncement: string,
  failureAnnouncement: string,
) {
  const [feedback, setFeedback] = useState<{
    result: Exclude<ClipboardCopyResult, 'idle'>
    text: string
  } | null>(null)
  const latestAttemptRef = useRef(0)
  const mountedRef = useRef(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      latestAttemptRef.current += 1
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
    }
  }, [])

  const settle = useCallback((
    next: Exclude<ClipboardCopyResult, 'idle'>,
    copiedText: string,
    announcement: string,
  ) => {
    setFeedback({ result: next, text: copiedText })
    AccessibilityInfo.announceForAccessibility(announcement)
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setFeedback(null)
    }, FEEDBACK_DURATION_MS)
  }, [])

  const copy = useCallback(async () => {
    const attempt = latestAttemptRef.current + 1
    latestAttemptRef.current = attempt
    try {
      const copied = await Clipboard.setStringAsync(text)
      if (!mountedRef.current || latestAttemptRef.current !== attempt) return
      settle(copied ? 'copied' : 'failed', text, copied ? successAnnouncement : failureAnnouncement)
    } catch {
      if (!mountedRef.current || latestAttemptRef.current !== attempt) return
      settle('failed', text, failureAnnouncement)
    }
  }, [failureAnnouncement, settle, successAnnouncement, text])

  const result: ClipboardCopyResult = feedback?.text === text ? feedback.result : 'idle'
  return { copy, result } as const
}
