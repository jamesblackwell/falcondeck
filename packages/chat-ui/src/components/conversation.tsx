import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, LoaderCircle, MessageSquare } from 'lucide-react'

import type { ConversationItem, FalconDeckPreferences } from '@falcondeck/client-core'
import { deriveConversationPresentation, normalizePreferences } from '@falcondeck/client-core'
import { EmptyState } from '@falcondeck/ui'

import { LiveActivityLane, MessageCard, ToolSummaryCard } from './message'

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
  preferences = null,
  emptyState,
  isThinking = false,
  isLoading = false,
}: {
  threadKey?: string | null
  items: ConversationItem[]
  preferences?: FalconDeckPreferences | null
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
  const [expansionMode, setExpansionMode] = useState<'default' | 'expanded' | 'collapsed'>('default')
  const renderableItems = useMemo(
    () =>
      items.filter(
        (item) => item.kind !== 'reasoning' && !(item.kind === 'interactive_request' && !item.resolved),
      ),
    [items],
  )
  const normalizedPreferences = useMemo(() => normalizePreferences(preferences), [preferences])
  const presentation = useMemo(
    () => deriveConversationPresentation(renderableItems, normalizedPreferences),
    [normalizedPreferences, renderableItems],
  )
  const renderBlocks = presentation.history_blocks
  const liveActivityGroups = presentation.live_activity_groups
  const hasHiddenOnlyItems = items.length > 0 && renderableItems.length === 0
  const showEmptyState =
    renderBlocks.length === 0 && liveActivityGroups.length === 0 && !hasHiddenOnlyItems

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
    setExpansionMode('default')
  }, [threadKey])

  useLayoutEffect(() => {
    if (isLoading) return
    if (lastRestoredThreadKeyRef.current === threadKey) return

    restoreThreadPosition()
    lastRestoredThreadKeyRef.current = threadKey
  }, [isLoading, restoreThreadPosition, threadKey])

  useLayoutEffect(() => {
    if (isLoading) return
    if (!renderBlocks.length && !isThinking) return

    if (!stickyToBottomRef.current) {
      persistScrollPosition()
      return
    }

    schedulePinToBottom()
  }, [isLoading, isThinking, persistScrollPosition, renderBlocks, schedulePinToBottom])

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-selectable
          className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain"
          onScroll={handleScroll}
        >
          <div ref={contentRef} className="mx-auto flex min-h-full max-w-3xl flex-col gap-3 px-5 py-4">
            {showEmptyState || (renderBlocks.length === 0 && isThinking && liveActivityGroups.length === 0) ? (
            <div className="flex min-h-full flex-1 flex-col gap-3">
              {showEmptyState
                ? emptyState ?? (
                    <EmptyState
                      icon={<MessageSquare className="h-6 w-6" />}
                      title="Ready for instructions"
                      description="Send a prompt to start a conversation."
                    />
                  )
                : null}
              {isThinking && liveActivityGroups.length === 0 ? (
                <div className="flex items-center gap-2 py-2 text-[length:var(--fd-text-sm)] text-fg-muted">
                  <LoaderCircle className="h-4 w-4 animate-spin text-accent" />
                  Thinking…
                </div>
              ) : null}
            </div>
          ) : null}

            {renderBlocks.length > 0 && normalizedPreferences.conversation.show_expand_all_controls ? (
            <div className="flex items-center justify-end gap-2 px-1">
              <button
                type="button"
                onClick={() => setExpansionMode('expanded')}
                className="text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:text-fg-primary"
              >
                Expand all
              </button>
              <button
                type="button"
                onClick={() => setExpansionMode('collapsed')}
                className="text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:text-fg-primary"
              >
                Collapse all
              </button>
            </div>
          ) : null}

            {renderBlocks.map((block) => (
            <div key={block.id} className="min-w-0">
              {block.kind === 'item' ? (
                <MessageCard
                  item={block.item}
                  defaultOpen={block.default_open}
                  expansionMode={expansionMode}
                  suppressReadOnlyDetail={block.suppress_read_only_detail}
                />
              ) : (
                <ToolSummaryCard
                  items={block.items}
                  summary={block.summary}
                  defaultOpen={block.default_open}
                  expansionMode={expansionMode}
                  suppressReadOnlyDetail={block.suppress_read_only_detail}
                />
              )}
            </div>
          ))}

            {renderBlocks.length > 0 && isThinking && liveActivityGroups.length === 0 ? (
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

      <LiveActivityLane groups={liveActivityGroups} />
    </div>
  )
})
