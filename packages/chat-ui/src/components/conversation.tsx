import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, LoaderCircle, MessageSquare } from 'lucide-react'

import type { ConversationItem } from '@falcondeck/client-core'
import { EmptyState } from '@falcondeck/ui'

import { MessageCard } from './message'

export const Conversation = memo(function Conversation({ items, emptyState, isThinking = false }: { items: ConversationItem[]; emptyState?: React.ReactNode; isThinking?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const [showJump, setShowJump] = useState(false)

  const lastItemId = items.length > 0 ? items[items.length - 1].id : null

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lastItemId])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowJump(distanceFromBottom > 200)
  }, [])

  const jumpToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-selectable
        className="h-full overflow-y-auto"
        onScroll={handleScroll}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-4">
          {items.length === 0 ? (
            emptyState ?? (
              <EmptyState
                icon={<MessageSquare className="h-6 w-6" />}
                title="Ready for instructions"
                description="Send a prompt to start a conversation with Codex."
              />
            )
          ) : null}
          {items.map((item) => (
            <div
              key={`${item.kind}-${item.id}`}
              style={{ contentVisibility: 'auto', containIntrinsicSize: '160px' }}
            >
              <MessageCard item={item} />
            </div>
          ))}
          {isThinking ? (
            <div className="flex items-center gap-2 py-2 text-[length:var(--fd-text-sm)] text-fg-muted">
              <LoaderCircle className="h-4 w-4 animate-spin text-accent" />
              Thinking…
            </div>
          ) : null}
          <div ref={endRef} />
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
