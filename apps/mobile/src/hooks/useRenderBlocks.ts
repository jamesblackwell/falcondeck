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
    // Unresolved approvals are dropped because ApprovalBanner already pins
    // them above the transcript.
    const filteredItems = items.filter((item) => {
      if (item.kind === 'interactive_request' && !item.resolved) return false
      return true
    })
    return deriveConversationPresentation(filteredItems, preferences)
  }, [items, preferences])
}

export function useRenderBlocks(): ConversationRenderBlock[] {
  return useConversationPresentation().history_blocks
}
