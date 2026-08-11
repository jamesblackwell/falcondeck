import { useMemo, useRef } from 'react'

import {
  deriveConversationPresentation,
  normalizePreferences,
  reuseConversationPresentation,
  threadForSelection,
  type ConversationPresentation,
  type ConversationRenderBlock,
} from '@falcondeck/client-core'

import { useConversationItems, useSessionStore } from '@/store'

export function useConversationPresentation(): ConversationPresentation {
  const items = useConversationItems()
  const preferences = useSessionStore((s) => s.snapshot?.preferences ?? null)
  // Subscribe to the smallest value the presentation needs. A running turn
  // keeps a trailing collapsed work session live even after its last tool has
  // settled; without this, iOS briefly claims the session already "Worked"
  // while the thought nested inside it is still streaming.
  const isStreaming = useSessionStore((s) =>
    threadForSelection(
      s.snapshot?.threads ?? [],
      s.selectedWorkspaceId,
      s.selectedThreadId,
    )?.status === 'running'
  )
  const presentationRef = useRef<ConversationPresentation | null>(null)

  // This ref is a render-only structural-sharing cache. React has no
  // previous-value form of useMemo; replacing it with ordinary memoization
  // recreates every FlashList row for each streamed token. The derivation is
  // pure and reuseConversationPresentation always validates block equality.
  /* eslint-disable react-hooks/refs */
  const presentation = useMemo(() => {
    // Reasoning stays in: the presentation layer folds it into the work
    // session it interleaves with, and ReasoningBlock renders the rest.
    // Every unresolved interaction lives in one ordered, pinned response
    // surface above the transcript. Resolved receipts stay in history for an
    // audit trail, but a pending question/approval must never be duplicated as
    // an inert or incorrectly actionable transcript row.
    const filteredItems = items.filter((item) => {
      if (item.kind === 'interactive_request' && !item.resolved) return false
      return true
    })
    // Auto-expanding the turn's first diff is a desktop nicety; on a phone a
    // multi-hundred-line edit snippet swallows the whole transcript. Edits
    // still surface as cards here — they just start collapsed. The same goes
    // for approval-related cards, whose outputs can run to tens of thousands
    // of characters.
    const normalized = normalizePreferences(preferences)
    const mobilePreferences = {
      ...normalized,
      conversation: {
        ...normalized.conversation,
        auto_expand: {
          ...normalized.conversation.auto_expand,
          first_diff: false,
          approvals: false,
        },
      },
    }
    const next = deriveConversationPresentation(filteredItems, mobilePreferences, {
      is_streaming: isStreaming,
    })
    const stable = reuseConversationPresentation(presentationRef.current, next)
    presentationRef.current = stable
    return stable
  }, [isStreaming, items, preferences])
  /* eslint-enable react-hooks/refs */
  return presentation
}

export function useRenderBlocks(): ConversationRenderBlock[] {
  return useConversationPresentation().history_blocks
}
