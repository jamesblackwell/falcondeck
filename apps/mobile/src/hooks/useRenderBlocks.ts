import { useMemo } from 'react'

import {
  deriveConversationRenderBlocks,
  type ConversationRenderBlock,
} from '@falcondeck/client-core'

import { useConversationItems, useSessionStore } from '@/store'

export function useRenderBlocks(): ConversationRenderBlock[] {
  const items = useConversationItems()
  const preferences = useSessionStore((s) => s.snapshot?.preferences ?? null)

  return useMemo(() => {
    const blocks = deriveConversationRenderBlocks(items, preferences)
    // Filter out reasoning items and unresolved interactive requests
    const filtered = blocks.filter((block) => {
      if (block.kind === 'tool_burst') return true
      if (block.item.kind === 'reasoning') return false
      if (block.item.kind === 'interactive_request' && !block.item.resolved) return false
      return true
    })
    return filtered
  }, [items, preferences])
}
