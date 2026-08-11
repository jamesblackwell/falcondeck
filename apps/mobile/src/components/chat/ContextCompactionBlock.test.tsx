import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { ConversationItem, ToolLifecycle } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '@/test/render'
import { ContextCompactionBlock } from './ContextCompactionBlock'

afterEach(cleanup)

function compaction(
  lifecycle: ToolLifecycle,
): Extract<ConversationItem, { kind: 'context_compaction' }> {
  return {
    kind: 'context_compaction',
    id: `compact-${lifecycle}`,
    lifecycle,
    created_at: '2026-08-09T10:00:00Z',
    completed_at: lifecycle === 'running' ? null : '2026-08-09T10:00:02Z',
  }
}

describe('ContextCompactionBlock', () => {
  it('announces running compaction as a polite lifecycle receipt', () => {
    const renderer = renderComponent(<ContextCompactionBlock item={compaction('running')} />)
    const receipt = renderer.root.findByProps({
      accessibilityLabel:
        'Compacting context. Summarizing earlier conversation so this thread can continue.',
    })

    expect(receipt.props.accessibilityLiveRegion).toBe('polite')
    expect(textOf(renderer)).toContain('Compacting context')
  })

  it('makes a failed compaction assertive while preserving explanatory copy', () => {
    const renderer = renderComponent(<ContextCompactionBlock item={compaction('failed')} />)
    const receipt = renderer.root.findByProps({ accessibilityRole: 'alert' })

    expect(receipt.props.accessibilityLiveRegion).toBe('assertive')
    expect(textOf(renderer)).toContain('The provider could not finish summarizing this thread.')
  })
})
