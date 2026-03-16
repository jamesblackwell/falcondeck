import { memo, useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'

import type { ConversationItem } from '@falcondeck/client-core'
import { EmptyState } from '@falcondeck/ui'

import { MessageCard } from './message'

export const Conversation = memo(function Conversation({ items }: { items: ConversationItem[] }) {
  const endRef = useRef<HTMLDivElement>(null)

  const lastItemId = items.length > 0 ? items[items.length - 1].id : null

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lastItemId])

  return (
    <div data-selectable className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-4">
        {items.length === 0 ? (
          <EmptyState
            icon={<MessageSquare className="h-6 w-6" />}
            title="Ready for instructions"
            description="Send a prompt to start a conversation with Codex."
          />
        ) : null}
        {items.map((item) => (
          <MessageCard key={`${item.kind}-${item.id}`} item={item} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
})
