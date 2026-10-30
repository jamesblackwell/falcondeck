import { describe, expect, it } from 'vitest'

import {
  contextCompactionPresentation,
  deriveConversationRenderBlocks,
} from './conversation'
import { normalizeConversationItem, normalizePreferences } from './normalization'
import type { ConversationItem } from './types'

function compactingNotice(id: string, level: 'info' | 'warning' = 'info'): ConversationItem {
  return {
    kind: 'service',
    id,
    level,
    message: 'compacting',
    created_at: '2026-08-09T10:00:00Z',
  }
}

const receipt: ConversationItem = {
  kind: 'context_compaction',
  id: 'compact-1',
  lifecycle: 'succeeded',
  created_at: '2026-08-09T10:00:00Z',
  completed_at: '2026-08-09T10:00:02Z',
}

describe('context compaction conversation semantics', () => {
  it.each(['collapsed', 'compact', 'expanded'] as const)(
    'replaces legacy progress notices with their receipt in %s mode',
    (mode) => {
      const items = [compactingNotice('status-1'), compactingNotice('status-2'), receipt]
      const original = [...items]
      const preferences = normalizePreferences(null)
      preferences.conversation.tool_details_mode = mode
      const blocks = deriveConversationRenderBlocks(items, preferences)

      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toMatchObject({ kind: 'item', item: receipt })
      expect(items).toEqual(original)
    },
  )

  it('preserves warnings and notices that belong to a different turn', () => {
    const warning = compactingNotice('warning', 'warning')
    const notice = compactingNotice('earlier-turn')
    const user: ConversationItem = {
      kind: 'user_message',
      id: 'user-1',
      text: 'Continue',
      attachments: [],
      created_at: '2026-08-09T10:00:01Z',
    }
    const blocks = deriveConversationRenderBlocks([notice, user, warning, receipt], null)

    expect(blocks.filter((block) => block.kind === 'item').map((block) => block.item))
      .toEqual([notice, user, warning, receipt])
  })

  it('normalizes legacy or unknown lifecycle values without hiding the receipt', () => {
    const item = normalizeConversationItem({
      kind: 'context_compaction',
      id: 'compact-1',
      lifecycle: 'future-state',
      created_at: '2026-08-09T10:00:00Z',
      completed_at: null,
    })

    expect(item).toMatchObject({
      kind: 'context_compaction',
      id: 'compact-1',
      lifecycle: 'unknown',
    })
  })

  it('presents running, successful, and failed states with explicit copy', () => {
    expect(contextCompactionPresentation('running')).toMatchObject({
      label: 'Compacting context',
      tone: 'progress',
    })
    expect(contextCompactionPresentation('succeeded')).toMatchObject({
      label: 'Context compacted',
      tone: 'success',
    })
    expect(contextCompactionPresentation('failed')).toMatchObject({
      label: 'Context compaction failed',
      tone: 'danger',
    })
  })

  it('keeps the receipt outside a collapsed work-session fold', () => {
    const tool: Extract<ConversationItem, { kind: 'tool_call' }> = {
      kind: 'tool_call',
      id: 'read-1',
      title: 'Read docs',
      tool_kind: 'read',
      status: 'completed',
      output: null,
      exit_code: null,
      display: {
        is_read_only: true,
        has_side_effect: false,
        is_error: false,
        lifecycle: 'succeeded',
        artifact_kind: 'none',
        activity_kind: 'read',
        history_mode: 'summary',
        summary_hint: 'docs',
      },
      detail: null,
      created_at: '2026-08-09T10:00:00Z',
      completed_at: '2026-08-09T10:00:01Z',
    }
    const compaction: Extract<ConversationItem, { kind: 'context_compaction' }> = {
      kind: 'context_compaction',
      id: 'compact-1',
      lifecycle: 'succeeded',
      created_at: '2026-08-09T10:00:02Z',
      completed_at: '2026-08-09T10:00:03Z',
    }

    const blocks = deriveConversationRenderBlocks([tool, compaction], null)

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.kind).toBe('work_session')
    expect(blocks[1]).toMatchObject({
      kind: 'item',
      item: { kind: 'context_compaction', id: 'compact-1' },
    })
  })
})
