import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, LoaderCircle, MessageSquare } from 'lucide-react'

import type { ConversationItem } from '@falcondeck/client-core'
import { EmptyState } from '@falcondeck/ui'

import { MessageCard } from './message'

const AUTO_SCROLL_THRESHOLD = 40
const JUMP_THRESHOLD = 200
const MAX_THREAD_UI_STATE = 48

type SavedScrollPosition = {
  scrollTop: number
  stickToBottom: boolean
}

function clampScrollTop(scrollTop: number, element: HTMLDivElement) {
  return Math.min(scrollTop, Math.max(0, element.scrollHeight - element.clientHeight))
}

export const Conversation = memo(function Conversation({
  threadKey = null,
  items,
  emptyState,
  isThinking = false,
  isLoading = false,
}: {
  threadKey?: string | null
  items: ConversationItem[]
  emptyState?: React.ReactNode
  isThinking?: boolean
  isLoading?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinToBottomFrameRef = useRef<number | null>(null)
  const scrollPositionsRef = useRef(new Map<string, SavedScrollPosition>())
  const activeThreadKeyRef = useRef<string | null>(threadKey)
  const lastRestoredThreadKeyRef = useRef<string | null>(null)
  const stickyToBottomRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const renderableItems = useMemo(
    () => items.filter((item) => item.kind !== 'reasoning'),
    [items],
  )

  useEffect(() => {
    if (!threadKey) return

    const savedPosition = scrollPositionsRef.current.get(threadKey)
    if (savedPosition) {
      scrollPositionsRef.current.delete(threadKey)
      scrollPositionsRef.current.set(threadKey, savedPosition)
    }

    while (scrollPositionsRef.current.size > MAX_THREAD_UI_STATE) {
      const oldestKey = scrollPositionsRef.current.keys().next().value
      if (!oldestKey) break
      scrollPositionsRef.current.delete(oldestKey)
    }
  }, [threadKey])

  const persistScrollPosition = useCallback(
    (keyOverride?: string | null) => {
      const key = keyOverride ?? threadKey
      const el = scrollRef.current
      if (!key || !el) return

      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      scrollPositionsRef.current.delete(key)
      scrollPositionsRef.current.set(key, {
        scrollTop: el.scrollTop,
        stickToBottom: distanceFromBottom <= AUTO_SCROLL_THRESHOLD,
      })
    },
    [threadKey],
  )

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
    stickyToBottomRef.current = true
    setShowJump(false)
    persistScrollPosition()
  }, [persistScrollPosition])

  const schedulePinToBottom = useCallback(() => {
    if (pinToBottomFrameRef.current !== null) {
      window.cancelAnimationFrame(pinToBottomFrameRef.current)
    }

    pinToBottomFrameRef.current = window.requestAnimationFrame(() => {
      pinToBottomFrameRef.current = window.requestAnimationFrame(() => {
        scrollToBottom()
        pinToBottomFrameRef.current = null
      })
    })
  }, [scrollToBottom])

  const restoreThreadPosition = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    const savedPosition = threadKey ? scrollPositionsRef.current.get(threadKey) ?? null : null
    if (!savedPosition || savedPosition.stickToBottom) {
      scrollToBottom()
      schedulePinToBottom()
      return
    }

    el.scrollTop = clampScrollTop(savedPosition.scrollTop, el)
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyToBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD
    setShowJump(distanceFromBottom > JUMP_THRESHOLD)
    persistScrollPosition()
  }, [persistScrollPosition, schedulePinToBottom, scrollToBottom, threadKey])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const isNearBottom = distanceFromBottom <= AUTO_SCROLL_THRESHOLD
    stickyToBottomRef.current = isNearBottom
    setShowJump(distanceFromBottom > JUMP_THRESHOLD)
    persistScrollPosition()
  }, [persistScrollPosition])

  useEffect(() => {
    if (activeThreadKeyRef.current === threadKey) return

    lastRestoredThreadKeyRef.current = null
    activeThreadKeyRef.current = threadKey
  }, [threadKey])

  useLayoutEffect(() => {
    if (isLoading) return
    if (lastRestoredThreadKeyRef.current === threadKey) return

    restoreThreadPosition()
    lastRestoredThreadKeyRef.current = threadKey
  }, [isLoading, restoreThreadPosition, threadKey])

  useLayoutEffect(() => {
    if (isLoading) return
    if (!renderableItems.length && !isThinking) return

    if (!stickyToBottomRef.current) {
      persistScrollPosition()
      return
    }

    schedulePinToBottom()
  }, [isLoading, isThinking, persistScrollPosition, renderableItems, schedulePinToBottom])

  useEffect(() => {
    if (!threadKey || isLoading) return

    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      if (!stickyToBottomRef.current) {
        persistScrollPosition()
        return
      }

      schedulePinToBottom()
    })
    observer.observe(content)

    return () => {
      observer.disconnect()
    }
  }, [isLoading, persistScrollPosition, schedulePinToBottom, threadKey])

  useEffect(() => {
    return () => {
      if (pinToBottomFrameRef.current !== null) {
        window.cancelAnimationFrame(pinToBottomFrameRef.current)
      }
    }
  }, [])

  const jumpToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-selectable
        className="h-full overflow-y-auto"
        onScroll={handleScroll}
      >
        <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-4">
          {renderableItems.length === 0 ? (
            <div className="flex flex-col gap-3">
              {emptyState ?? (
                <EmptyState
                  icon={<MessageSquare className="h-6 w-6" />}
                  title="Ready for instructions"
                  description="Send a prompt to start a conversation with Codex."
                />
              )}
              {isThinking ? (
                <div className="flex items-center gap-2 py-2 text-[length:var(--fd-text-sm)] text-fg-muted">
                  <LoaderCircle className="h-4 w-4 animate-spin text-accent" />
                  Thinking…
                </div>
              ) : null}
            </div>
          ) : null}

          {renderableItems.map((item) => (
            <div key={`${item.kind}-${item.id}`} className="min-w-0">
              <MessageCard item={item} />
            </div>
          ))}

          {renderableItems.length > 0 && isThinking ? (
            <div className="flex items-center gap-2 py-2 text-[length:var(--fd-text-sm)] text-fg-muted">
              <LoaderCircle className="h-4 w-4 animate-spin text-accent" />
              Thinking…
            </div>
          ) : null}
        </div>
      </div>

      {showJump ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-3">
          <button
            type="button"
            onClick={jumpToBottom}
            className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-border-default bg-surface-2 text-fg-muted shadow-md transition-colors hover:bg-surface-3 hover:text-fg-primary"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  )
})
