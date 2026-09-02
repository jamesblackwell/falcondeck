import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceSummary } from '@falcondeck/client-core'

import { NewThreadState } from './new-thread-state'

function workspace(path: string, kind?: 'project' | 'casual'): WorkspaceSummary {
  return {
    id: 'ws-1',
    path,
    kind,
    status: 'ready',
    agents: [],
    models: [],
    collaboration_modes: [],
    account: { status: 'unknown', label: null },
    current_thread_id: null,
    connected_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    last_error: null,
  } as unknown as WorkspaceSummary
}

describe('NewThreadState', () => {
  it('opens the project picker from the highlighted project name', () => {
    const onOpenProjectPicker = vi.fn()
    render(
      <NewThreadState
        selectedWorkspace={workspace('/Users/dev/lucidpic')}
        onOpenProjectPicker={onOpenProjectPicker}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'lucidpic' }))
    expect(onOpenProjectPicker).toHaveBeenCalledOnce()
  })

  it('opens the project picker when no project is selected', () => {
    const onOpenProjectPicker = vi.fn()
    render(
      <NewThreadState
        selectedWorkspace={null}
        onOpenProjectPicker={onOpenProjectPicker}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'project' }))
    expect(onOpenProjectPicker).toHaveBeenCalledOnce()
  })

  it('does not offer a project picker in a casual chat', () => {
    render(
      <NewThreadState
        selectedWorkspace={workspace(
          '/Users/dev/Documents/FalconDeck/2026-08-24/chat-120000-abcdef',
          'casual',
        )}
        onOpenProjectPicker={vi.fn()}
      />,
    )

    expect(
      screen.getByText('What would you like to talk about?'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
