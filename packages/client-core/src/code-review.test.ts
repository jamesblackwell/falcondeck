import { describe, expect, it } from 'vitest'

import { codeReviewPresentation, deriveConversationRenderBlocks } from './conversation'
import { normalizeConversationItem } from './normalization'
import type { ConversationItem } from './types'

describe('code review conversation semantics', () => {
  it('normalizes provider lifecycle while preserving subject and Markdown findings', () => {
    const item = normalizeConversationItem({
      kind: 'code_review',
      id: 'review-1',
      subject: 'current changes',
      content: '## Findings\n\n- Fix the race.',
      lifecycle: 'streaming',
      created_at: '2026-08-09T10:00:00Z',
    })

    expect(item).toMatchObject({
      kind: 'code_review',
      subject: 'current changes',
      content: '## Findings\n\n- Fix the race.',
      lifecycle: 'streaming',
    })
  })

  it('uses consistent lifecycle copy for running and terminal reviews', () => {
    expect(codeReviewPresentation('streaming', 'current changes')).toMatchObject({
      label: 'Reviewing current changes',
      tone: 'progress',
    })
    expect(codeReviewPresentation('complete', 'current changes')).toMatchObject({
      label: 'Code review',
      detail: 'Review of current changes',
      tone: 'success',
    })
    expect(codeReviewPresentation('interrupted', null)).toMatchObject({
      label: 'Code review interrupted',
      tone: 'warning',
    })
    expect(codeReviewPresentation('error', null)).toMatchObject({
      label: 'Code review failed',
      tone: 'danger',
    })
  })

  it('keeps review findings outside collapsed tool work', () => {
    const tool: Extract<ConversationItem, { kind: 'tool_call' }> = {
      kind: 'tool_call',
      id: 'read-1',
      title: 'Read source',
      tool_kind: 'commandExecution',
      status: 'completed',
      output: null,
      exit_code: 0,
      display: {
        is_read_only: true,
        has_side_effect: false,
        is_error: false,
        lifecycle: 'succeeded',
        artifact_kind: 'none',
        activity_kind: 'read',
        history_mode: 'summary',
        summary_hint: 'Read source',
      },
      detail: null,
      created_at: '2026-08-09T10:00:00Z',
      completed_at: '2026-08-09T10:00:01Z',
    }
    const review: Extract<ConversationItem, { kind: 'code_review' }> = {
      kind: 'code_review',
      id: 'review-1',
      subject: 'current changes',
      content: 'No findings.',
      lifecycle: 'complete',
      created_at: '2026-08-09T10:00:02Z',
    }

    const blocks = deriveConversationRenderBlocks([tool, review], null)

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.kind).toBe('work_session')
    expect(blocks[1]).toMatchObject({
      kind: 'item',
      item: { kind: 'code_review', id: 'review-1' },
    })
  })
})
