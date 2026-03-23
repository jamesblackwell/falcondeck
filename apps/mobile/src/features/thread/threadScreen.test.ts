import { describe, expect, it } from 'vitest'

import type { ConversationPresentation, ConversationRenderBlock } from '@falcondeck/client-core'

import { shouldShowThinkingIndicator, getWorkspaceTitle } from './threadScreen'

describe('threadScreen helpers', () => {
  function presentation(history_blocks: ConversationRenderBlock[]): ConversationPresentation {
    return {
      history_blocks,
      live_activity_groups: [],
    }
  }

  it('falls back to the app title when the workspace path is missing', () => {
    expect(getWorkspaceTitle(undefined)).toBe('FalconDeck')
    expect(getWorkspaceTitle('')).toBe('FalconDeck')
  })

  it('uses the workspace basename when present', () => {
    expect(getWorkspaceTitle('/tmp/falcondeck')).toBe('falcondeck')
  })

  it('shows thinking while a running thread has no blocks yet', () => {
    expect(shouldShowThinkingIndicator(presentation([]), true)).toBe(true)
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

    expect(shouldShowThinkingIndicator(presentation(blocks), true)).toBe(false)
  })

  it('hides thinking when the latest block is a tool summary', () => {
    const blocks = [
      {
        id: 'burst-1',
        kind: 'tool_summary',
        default_open: false,
        suppress_read_only_detail: false,
        items: [],
        summary: {
          family: 'explore',
          count: 1,
          title: '1 read-only tool',
          subtitle: null,
          labels: [],
          counts: { read: 1 },
          started_at: '2026-03-16T10:00:00Z',
          completed_at: '2026-03-16T10:01:00Z',
          summary_hint: null,
        },
      },
    ] as ConversationRenderBlock[]

    expect(shouldShowThinkingIndicator(presentation(blocks), true)).toBe(false)
  })

  it('hides thinking when live activity is present', () => {
    expect(
      shouldShowThinkingIndicator(
        {
          history_blocks: [],
          live_activity_groups: [
            {
              kind: 'live_activity_group',
              id: 'live-1',
              items: [],
              summary: {
                family: 'explore',
                count: 1,
                title: 'Exploring 1 file',
                subtitle: null,
                labels: [],
                counts: { read: 1 },
                started_at: '2026-03-16T10:00:00Z',
                completed_at: null,
                summary_hint: null,
              },
            },
          ],
        },
        true,
      ),
    ).toBe(false)
  })
})
