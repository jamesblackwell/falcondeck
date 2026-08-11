import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'

import { cn } from '../lib/utils'

export type CopyButtonProps = {
  text: string
  className?: string
  variant?: 'icon' | 'labeled'
  label?: string
  copiedLabel?: string
}

export const CopyButton = memo(function CopyButton({
  text,
  className,
  variant = 'icon',
  label = 'Copy',
  copiedLabel = 'Copied',
}: CopyButtonProps) {
  const [feedback, setFeedback] = useState<{
    result: 'copied' | 'failed'
    text: string
  } | null>(null)
  const resetTimerRef = useRef<number | null>(null)
  const latestAttemptRef = useRef(0)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      latestAttemptRef.current += 1
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    }
  }, [])

  const handleCopy = useCallback(() => {
    const attempt = latestAttemptRef.current + 1
    latestAttemptRef.current = attempt
    const settle = (next: 'copied' | 'failed') => {
      if (!mountedRef.current || latestAttemptRef.current !== attempt) return
      setFeedback({ result: next, text })
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setFeedback(null)
      }, 1500)
    }

    // Confirming before the write resolves is a lie the user only discovers at
    // the paste — and the clipboard API both rejects routinely in webviews
    // without a user-gesture chain and is absent outside secure contexts.
    const write = navigator.clipboard?.writeText(text)
    if (!write) {
      settle('failed')
      return
    }
    write.then(
      () => settle('copied'),
      () => settle('failed'),
    )
  }, [text])

  const result = feedback?.text === text ? feedback.result : 'idle'
  const copied = result === 'copied'
  const failed = result === 'failed'
  const currentLabel = copied ? copiedLabel : failed ? 'Copy failed' : label
  const icon = copied ? (
    <Check aria-hidden="true" className="h-3 w-3 text-success" />
  ) : failed ? (
    <X aria-hidden="true" className="h-3 w-3 text-danger" />
  ) : (
    <Copy aria-hidden="true" className="h-3 w-3" />
  )

  if (variant === 'labeled') {
    return (
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          'fd-focus inline-flex items-center gap-1 rounded-[var(--fd-radius-sm)] px-2 py-1 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary',
          className,
        )}
      >
        {icon}
        {currentLabel}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={currentLabel}
      className={cn(
        'fd-focus inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary',
        className,
      )}
    >
      {icon}
    </button>
  )
})
