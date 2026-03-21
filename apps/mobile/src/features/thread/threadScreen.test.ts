import { describe, expect, it } from 'vitest'

import type { ConversationRenderBlock } from '@falcondeck/client-core'

import { shouldShowThinkingIndicator, getWorkspaceTitle } from './threadScreen'

describe('threadScreen helpers', () => {
  it('falls back to the app title when the workspace path is missing', () => {
    expect(getWorkspaceTitle(undefined)).toBe('FalconDeck')
    expect(getWorkspaceTitle('')).toBe('FalconDeck')
  })

  it('uses the workspace basename when present', () => {
    expect(getWorkspaceTitle('/tmp/falcondeck')).toBe('falcondeck')
  })

  it('shows thinking while a running thread has no blocks yet', () => {
    expect(shouldShowThinkingIndicator([], true)).toBe(true)
  })

  it('hides thinking when the latest block is an active tool call', () => {
    const blocks = [
      {
        id: '1',
        kind: 'item',
        default_open: false,
        suppress_read_only_detail: false,
        item: {
          id: 'tool-1',
          kind: 'tool_call',
          title: 'Read file',
          status: 'running',
          output: null,
        },
      },
    ] as ConversationRenderBlock[]

    expect(shouldShowThinkingIndicator(blocks, true)).toBe(false)
  })

  it('hides thinking when the latest block is a tool burst', () => {
    const blocks = [
      {
        id: 'burst-1',
        kind: 'tool_burst',
        default_open: false,
        suppress_read_only_detail: false,
        items: [],
        summary: {
          count: 1,
          labels: [],
          started_at: '2026-03-16T10:00:00Z',
          completed_at: '2026-03-16T10:01:00Z',
          summary_hint: null,
        },
      },
    ] as ConversationRenderBlock[]

    expect(shouldShowThinkingIndicator(blocks, true)).toBe(false)
  })
})
