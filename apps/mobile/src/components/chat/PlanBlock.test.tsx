import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ConversationItem } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '@/test/render'
import { PlanBlock } from './PlanBlock'

afterEach(cleanup)

const item = {
  kind: 'plan',
  id: 'plan-1',
  plan: {
    explanation: 'Ship a reliable conversation surface.',
    steps: [
      { id: 'inspect', step: 'Inspect current state', status: 'done' },
      { id: 'implement', step: 'Implement parity', status: 'running' },
      { id: 'qa', step: 'QA every client', status: 'failed' },
      { id: 'future', step: 'Handle future provider state', status: 'paused_by_provider' },
    ],
  },
  created_at: '2026-08-09T12:00:00Z',
} satisfies Extract<ConversationItem, { kind: 'plan' }>

describe('PlanBlock', () => {
  it('renders the same visible and accessible step states as desktop', () => {
    const renderer = renderComponent(<PlanBlock item={item} />)

    expect(textOf(renderer)).toContain('Plan')
    expect(textOf(renderer)).toContain('Completed')
    expect(textOf(renderer)).toContain('In progress')
    expect(textOf(renderer)).toContain('Failed')
    expect(textOf(renderer)).toContain('Paused by provider')
    expect(renderer.root.findByProps({ accessibilityLabel: 'Plan, 4 steps' })).toBeDefined()
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'QA every client, Failed' }),
    ).toBeDefined()
    const selectableText = renderer.root
      .findAllByType('Text' as any)
      .filter((node) => node.props.selectable === true)
      .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'))
      .join('\n')
    expect(selectableText).toContain('Ship a reliable conversation surface.')
    expect(selectableText).toContain('Inspect current state')
    expect(selectableText).toContain('Handle future provider state')
  })
})
