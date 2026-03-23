import { useMemo } from 'react'

import {
  deriveConversationPresentation,
  type ConversationPresentation,
  type ConversationRenderBlock,
} from '@falcondeck/client-core'

import { useConversationItems, useSessionStore } from '@/store'

export function useConversationPresentation(): ConversationPresentation {
  const items = useConversationItems()
  const preferences = useSessionStore((s) => s.snapshot?.preferences ?? null)

  return useMemo(() => {
    const filteredItems = items.filter((item) => {
      if (item.kind === 'reasoning') return false
      if (item.kind === 'interactive_request' && !item.resolved) return false
      return true
    })
    return deriveConversationPresentation(filteredItems, preferences)
  }, [items, preferences])
}

export function useRenderBlocks(): ConversationRenderBlock[] {
  return useConversationPresentation().history_blocks
}
