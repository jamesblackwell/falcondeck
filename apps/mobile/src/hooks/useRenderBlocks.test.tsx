import React from 'react'
import { describe, expect, it, vi } from 'vitest'

const { deriveBlocksMock, itemsMock, sessionStoreMock } = vi.hoisted(() => ({
  deriveBlocksMock: vi.fn(),
  itemsMock: vi.fn(),
  sessionStoreMock: vi.fn(),
}))

vi.mock('@/store', () => ({
  useConversationItems: () => itemsMock(),
  useSessionStore: (selector: (state: any) => unknown) =>
    selector(sessionStoreMock()),
}))

vi.mock('@falcondeck/client-core', async () => {
  const actual = await vi.importActual<object>('@falcondeck/client-core')
  return {
    ...actual,
    deriveConversationRenderBlocks: (...args: any[]) => deriveBlocksMock(...args),
  }
})

import { renderComponent } from '@/test/render'

import { useRenderBlocks } from './useRenderBlocks'

describe('useRenderBlocks', () => {
  it('filters reasoning and unresolved interactive requests while preserving order', () => {
    let result: ReturnType<typeof useRenderBlocks> = []

    itemsMock.mockReturnValue(['item-1'])
    sessionStoreMock.mockReturnValue({
      snapshot: {
        preferences: { conversation: { group_read_only_tools: true } },
      },
    })
    deriveBlocksMock.mockReturnValue([
      { id: '1', kind: 'item', item: { kind: 'assistant_message' } },
      { id: '2', kind: 'item', item: { kind: 'reasoning' } },
      { id: '3', kind: 'tool_burst', items: [], summary: {} },
      { id: '4', kind: 'item', item: { kind: 'interactive_request', resolved: false } },
      { id: '5', kind: 'item', item: { kind: 'interactive_request', resolved: true } },
    ])

    function Harness() {
      result = useRenderBlocks()
      return null
    }

    renderComponent(<Harness />)

    expect(deriveBlocksMock).toHaveBeenCalledWith(
      ['item-1'],
      { conversation: { group_read_only_tools: true } },
    )
    expect(result.map((block) => block.id)).toEqual(['1', '3', '5'])
  })
})
