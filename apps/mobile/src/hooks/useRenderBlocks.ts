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
    // Reasoning stays in: the presentation layer folds it into the work
    // session it interleaves with, and ReasoningBlock renders the rest.
    // Permission requests live in one consistent, queued surface above the
    // transcript. Keeping resolved copies here made the same prompt appear to
    // jump between two parts of the screen. Question requests remain in the
    // conversation until their dedicated response UI is consolidated too.
    const filteredItems = items.filter((item) => {
      if (item.kind === 'interactive_request' && item.request.kind === 'approval') return false
      return true
    })
    return deriveConversationPresentation(filteredItems, preferences)
  }, [items, preferences])
}

export function useRenderBlocks(): ConversationRenderBlock[] {
  return useConversationPresentation().history_blocks
}
