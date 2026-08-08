import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, LoaderCircle, MessageSquare, ShieldQuestion } from 'lucide-react'

import type { ConversationItem, FalconDeckPreferences } from '@falcondeck/client-core'
import { deriveConversationPresentation, normalizePreferences } from '@falcondeck/client-core'
import { EmptyState } from '@falcondeck/ui'

import { FileDiffProvider, type OpenFileDiff } from '../lib/file-diff-context'
import { LiveActivityLane, MessageCard, ToolSummaryCard, WorkSessionCard } from './message'

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

/** Pinned notice for a turn blocked on the user. The actionable card lives in
    the approval bar just below the transcript; this row makes the blocked
    state visible from within the conversation flow. */
function WaitingForApprovalNotice() {
  return (
    <div className="flex items-center gap-2 py-2 text-[length:var(--fd-text-sm)] text-fg-muted">
      <ShieldQuestion className="h-4 w-4 animate-pulse text-warning" />
      Waiting for approval — respond below to continue
    </div>
  )
}

export const Conversation = memo(function Conversation({
  threadKey = null,
  items,
  preferences = null,
  emptyState,
  isThinking = false,
  isWaitingForInput = false,
  isLoading = false,
  onOpenFile = null,
}: {
  threadKey?: string | null
  items: ConversationItem[]
  preferences?: FalconDeckPreferences | null
  emptyState?: React.ReactNode
  isThinking?: boolean
  /** The turn is blocked on an approval or question. Renders a pinned notice
      so the thread can never look idle while the agent is waiting on the user. */
  isWaitingForInput?: boolean
  isLoading?: boolean
  /** Opens a file's diff in the host's side panel; omit where there is none. */
  onOpenFile?: OpenFileDiff | null
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
  // Unresolved requests live in the pinned approval bar, not the transcript.
  // Reasoning stays in: it is rendered by the thinking-display rules below.
  const renderableItems = useMemo(
    () => items.filter((item) => !(item.kind === 'interactive_request' && !item.resolved)),
    [items],
  )
  const normalizedPreferences = useMemo(() => normalizePreferences(preferences), [preferences])
  const presentation = useMemo(
    () =>
      deriveConversationPresentation(renderableItems, normalizedPreferences, {
        is_streaming: isThinking,
      }),
    [isThinking, normalizedPreferences, renderableItems],
  )
  const renderBlocks = presentation.history_blocks
  const liveActivityGroups = presentation.live_activity_groups
  // A running work-session block already shows its own "Working…" line, so
  // the standalone "Thinking…" indicator would be redundant next to it.
  const hasRunningWorkSession = renderBlocks.some(
    (block) => block.kind === 'work_session' && block.running,
  )
  const thinkingDisplay = normalizedPreferences.conversation.thinking_display
  // Only the trailing thought is still arriving; anything a later item follows
  // has finished, which is what `auto` keys its collapse off.
  const streamingReasoningId = useMemo(() => {
    if (!isThinking) return null
    const last = renderableItems.at(-1)
    return last?.kind === 'reasoning' ? last.id : null
  }, [isThinking, renderableItems])
  const hasHiddenOnlyItems = items.length > 0 && renderableItems.length === 0
  // "Ready for instructions" claims the thread is idle and empty, so any busy
  // signal outranks it: a just-submitted prompt hasn't echoed into `items` yet
  // (isThinking covers that gap), a blocked turn is waiting on the user, and a
  // hydrating thread hasn't revealed whether it is empty at all.
  const showEmptyState =
    renderBlocks.length === 0 &&
    liveActivityGroups.length === 0 &&
    !hasHiddenOnlyItems &&
    !isThinking &&
    !isWaitingForInput &&
    !isLoading

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

  /// Pins to the bottom before the browser paints. Streaming must use this:
  /// deferring the scroll by even one frame paints the taller content at the
  /// old offset first, so every delta shows as a visible upward jump.
  const pinToBottomNow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
    stickyToBottomRef.current = true
    if (threadKey) {
      scrollPositionsRef.current.delete(threadKey)
      scrollPositionsRef.current.set(threadKey, { scrollTop: el.scrollTop, stickToBottom: true })
    }
  }, [threadKey])

  /// Deferred pin, for thread switches only: restored content (images, code
  /// blocks, fonts) settles its height over the next couple of frames, so the
  /// final position is not knowable synchronously.
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
    if (!renderBlocks.length && !isThinking && !isWaitingForInput) return
    // ResizeObserver below runs after layout and before paint. Avoid doing the
    // same forced scroll-height read twice on every streaming update.
    if (typeof ResizeObserver !== 'undefined') return

    if (!stickyToBottomRef.current) {
      persistScrollPosition()
      return
    }

    pinToBottomNow()
  }, [isLoading, isThinking, isWaitingForInput, persistScrollPosition, renderBlocks, pinToBottomNow])

  useEffect(() => {
    if (!threadKey || isLoading) return

    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    // Resize callbacks are delivered after layout and before paint, so pin
    // synchronously here too — scheduling a frame would reintroduce the
    // paint-then-snap jitter for content that grows while streaming.
    const observer = new ResizeObserver(() => {
      if (!stickyToBottomRef.current) {
        persistScrollPosition()
        return
      }

      pinToBottomNow()
    })
    observer.observe(content)

    return () => {
      observer.disconnect()
    }
  }, [isLoading, persistScrollPosition, pinToBottomNow, threadKey])

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
    <FileDiffProvider onOpenFile={onOpenFile}>
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-selectable
          className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain"
          onScroll={handleScroll}
        >
          <div
            ref={contentRef}
            className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 px-3 pt-4 pb-10 md:px-6 md:pb-12"
          >
            {showEmptyState ||
            (renderBlocks.length === 0 &&
              (isThinking || isWaitingForInput) &&
              liveActivityGroups.length === 0) ? (
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
              {isWaitingForInput && liveActivityGroups.length === 0 ? (
                <WaitingForApprovalNotice />
              ) : isThinking && liveActivityGroups.length === 0 ? (
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
                className="fd-focus rounded-[var(--fd-radius-sm)] text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:text-fg-primary"
              >
                Expand all
              </button>
              <button
                type="button"
                onClick={() => setExpansionMode('collapsed')}
                className="fd-focus rounded-[var(--fd-radius-sm)] text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:text-fg-primary"
              >
                Collapse all
              </button>
            </div>
          ) : null}

            {renderBlocks.map((block) => (
            <div key={block.id} className="fd-conversation-block min-w-0">
              {block.kind === 'item' ? (
                <MessageCard
                  item={block.item}
                  defaultOpen={block.default_open}
                  expansionMode={expansionMode}
                  suppressReadOnlyDetail={block.suppress_read_only_detail}
                  thinkingDisplay={thinkingDisplay}
                  isStreamingReasoning={block.item.id === streamingReasoningId}
                />
              ) : block.kind === 'work_session' ? (
                <WorkSessionCard
                  items={block.items}
                  running={block.running}
                  startedAt={block.started_at}
                  completedAt={block.completed_at}
                  expansionMode={expansionMode}
                  thinkingDisplay={thinkingDisplay}
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

            {/* A blocked turn outranks every indicator heuristic: whatever the
                transcript's tail looks like, the user must see that the agent
                is waiting on them. */}
            {renderBlocks.length > 0 && isWaitingForInput ? <WaitingForApprovalNotice /> : null}

            {/* A streaming thought already says "Thinking…" in its own header. */}
            {renderBlocks.length > 0 &&
            isThinking &&
            !isWaitingForInput &&
            liveActivityGroups.length === 0 &&
            !hasRunningWorkSession &&
            !streamingReasoningId ? (
            <div className="flex items-center gap-2 py-2 text-[length:var(--fd-text-sm)] text-fg-muted">
              <LoaderCircle className="h-4 w-4 animate-spin text-accent" />
              Thinking…
            </div>
          ) : null}

            {/* In-flight tool activity renders in the thread flow, where the
                completed groups it becomes will also live. */}
            <LiveActivityLane groups={liveActivityGroups} />
          </div>
        </div>

        {showJump ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-3">
            <button
              type="button"
              onClick={jumpToBottom}
              className="fd-focus pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-border-default bg-surface-2 text-fg-muted shadow-md transition-colors hover:bg-surface-3 hover:text-fg-primary"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        ) : null}
      </div>
      </div>
    </FileDiffProvider>
  )
})
