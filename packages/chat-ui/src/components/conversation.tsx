import type { ConversationItem } from '@falcondeck/client-core'

import { ScrollArea } from '@falcondeck/ui'

import { MessageCard } from './message'

export function Conversation({ items }: { items: ConversationItem[] }) {
  return (
    <ScrollArea className="h-full rounded-[28px] border border-white/10 bg-[rgba(10,14,12,0.72)]">
      <div className="flex flex-col gap-4 p-6">
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-8 text-sm text-zinc-400">
            No messages yet. Start a thread or send a prompt to Codex.
          </div>
        ) : null}
        {items.map((item) => (
          <MessageCard key={`${item.kind}-${item.id}`} item={item} />
        ))}
      </div>
    </ScrollArea>
  )
}
