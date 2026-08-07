import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import type { ConversationItem } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '../../test/render'
import { ReasoningBlock } from './ReasoningBlock'

afterEach(cleanup)

type ReasoningItem = Extract<ConversationItem, { kind: 'reasoning' }>

function reasoning(overrides: Partial<ReasoningItem> = {}): ReasoningItem {
  return {
    kind: 'reasoning',
    id: 'reasoning-1',
    summary: 'Weighing the options',
    content: 'First I will read the config, then run the tests.',
    created_at: '2026-03-16T10:00:00Z',
    ...overrides,
  }
}

function findPressables(renderer: ReturnType<typeof renderComponent>) {
  return renderer.root.findAllByType('Pressable' as never)
}

describe('ReasoningBlock', () => {
  it('shows the summary as the header and hides the thought by default', () => {
    const r = renderComponent(<ReasoningBlock item={reasoning()} display="auto" />)
    expect(textOf(r)).toContain('Weighing the options')
    expect(textOf(r)).not.toContain('First I will read the config')
  })

  it('falls back to a generic header when the provider sent no summary', () => {
    const r = renderComponent(<ReasoningBlock item={reasoning({ summary: null })} display="auto" />)
    expect(textOf(r)).toContain('Thought process')
  })

  it('reveals the thought when the header is tapped', () => {
    const r = renderComponent(<ReasoningBlock item={reasoning()} display="auto" />)
    act(() => {
      findPressables(r)[0]!.props.onPress()
    })
    expect(textOf(r)).toContain('First I will read the config')
  })

  it('starts open under always_expanded', () => {
    const r = renderComponent(<ReasoningBlock item={reasoning()} display="always_expanded" />)
    expect(textOf(r)).toContain('First I will read the config')
  })

  it('keeps a capped excerpt visible under preview', () => {
    const r = renderComponent(<ReasoningBlock item={reasoning()} display="preview" />)
    expect(textOf(r)).toContain('First I will read the config')
  })

  it('is not toggleable when the thought has no content', () => {
    const r = renderComponent(<ReasoningBlock item={reasoning({ content: '  ' })} display="auto" />)
    const header = findPressables(r)[0]!
    expect(header.props.disabled).toBe(true)
    expect(header.props.accessibilityState.expanded).toBe(false)
  })

  it('labels the header for VoiceOver', () => {
    const r = renderComponent(<ReasoningBlock item={reasoning()} display="auto" />)
    expect(findPressables(r)[0]!.props.accessibilityLabel).toBe('Reasoning: Weighing the options')
  })
})
