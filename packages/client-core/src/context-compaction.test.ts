import { describe, expect, it } from 'vitest'

import {
  contextCompactionPresentation,
  deriveConversationRenderBlocks,
} from './conversation'
import { normalizeConversationItem } from './normalization'
import type { ConversationItem } from './types'

describe('context compaction conversation semantics', () => {
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
