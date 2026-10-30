import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Conversation, MessageCard } from '@falcondeck/chat-ui'
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
    expect(screen.queryByText('Earlier conversation was summarized for continuity.')).not.toBeInTheDocument()

    view.rerender(<MessageCard item={compaction('failed')} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Context compaction failed')
    expect(screen.getByRole('alert')).toHaveTextContent('The provider could not finish summarizing this thread.')
  })

  it('renders one receipt for the legacy duplicated compaction sequence', () => {
    const notice: ConversationItem = {
      kind: 'service',
      id: 'notice-1',
      level: 'info',
      message: 'compacting',
      created_at: '2026-08-09T10:00:00Z',
    }
    render(<Conversation items={[notice, { ...notice, id: 'notice-2' }, compaction('succeeded')]} />)

    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Context compacted')
    expect(screen.queryByText('compacting')).not.toBeInTheDocument()
  })
})
