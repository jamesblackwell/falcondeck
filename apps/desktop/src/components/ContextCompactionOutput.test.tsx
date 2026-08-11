import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MessageCard } from '@falcondeck/chat-ui'
import type { ConversationItem, ToolLifecycle } from '@falcondeck/client-core'

function compaction(lifecycle: ToolLifecycle): ConversationItem {
  return {
    kind: 'context_compaction',
    id: `compact-${lifecycle}`,
    lifecycle,
    created_at: '2026-08-09T10:00:00Z',
    completed_at: lifecycle === 'running' ? null : '2026-08-09T10:00:02Z',
  }
}

describe('context compaction output', () => {
  it('announces progress without presenting compaction as a tool', () => {
    render(<MessageCard item={compaction('running')} />)

    const status = screen.getByRole('status')
    expect(status).toHaveAccessibleName(
      'Compacting context. Summarizing earlier conversation so this thread can continue.',
    )
    expect(status).toHaveTextContent('Compacting context')
  })

  it('renders a calm successful receipt and an assertive failure', () => {
    const view = render(<MessageCard item={compaction('succeeded')} />)
    expect(screen.getByRole('status')).toHaveTextContent('Context compacted')

    view.rerender(<MessageCard item={compaction('failed')} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Context compaction failed')
  })
})
