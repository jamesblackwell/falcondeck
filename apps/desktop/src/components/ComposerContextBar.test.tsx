import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ComposerContextBar } from '@falcondeck/chat-ui'
import type { WorkspaceSummary } from '@falcondeck/client-core'

function workspace(id: string, path: string): WorkspaceSummary {
  return {
    id,
    path,
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

const baseProps = {
  workspaces: [workspace('ws-1', '/Users/dev/falcondeck'), workspace('ws-2', '/Users/dev/lucidpic')],
  selectedWorkspace: workspace('ws-1', '/Users/dev/falcondeck'),
  onSelectWorkspace: vi.fn(),
  selectedIsolation: 'project_folder' as const,
  onIsolationChange: vi.fn(),
}

describe('ComposerContextBar', () => {
  it('shows the project, isolation, and branch chips for a git workspace', () => {
    render(
      <ComposerContextBar
        {...baseProps}
        branches={{ current: 'main', branches: ['main', 'codex/ui-sharing-merge'] }}
        uncommittedCount={22}
        onCheckoutBranch={vi.fn()}
      />,
    )

    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent('falcondeck')
    expect(screen.getByRole('combobox', { name: 'Work in' })).toHaveTextContent('Project folder')
    expect(screen.getByRole('button', { name: 'Git branch' })).toHaveTextContent('main')
  })

  it('hides the branch chip when the workspace has no branch data', () => {
    render(<ComposerContextBar {...baseProps} branches={null} onCheckoutBranch={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Git branch' })).not.toBeInTheDocument()
  })

  it('checks out an existing branch from the menu and shows the uncommitted count', () => {
    const onCheckoutBranch = vi.fn()
    render(
      <ComposerContextBar
        {...baseProps}
        branches={{ current: 'main', branches: ['main', 'feature/context-bar'] }}
        uncommittedCount={3}
        onCheckoutBranch={onCheckoutBranch}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Git branch' }))
    expect(screen.getByText('Uncommitted: 3 files')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /feature\/context-bar/ }))
    expect(onCheckoutBranch).toHaveBeenCalledWith('feature/context-bar', false)
  })

  it('creates and checks out a new branch through the inline form', () => {
    const onCheckoutBranch = vi.fn()
    render(
      <ComposerContextBar
        {...baseProps}
        branches={{ current: 'main', branches: ['main'] }}
        onCheckoutBranch={onCheckoutBranch}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Git branch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create and checkout new branch…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New branch name' }), {
      target: { value: 'feature/new-idea' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCheckoutBranch).toHaveBeenCalledWith('feature/new-idea', true)
  })

  it('selecting the current branch closes the menu without a checkout', () => {
    const onCheckoutBranch = vi.fn()
    render(
      <ComposerContextBar
        {...baseProps}
        branches={{ current: 'main', branches: ['main', 'other'] }}
        onCheckoutBranch={onCheckoutBranch}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Git branch' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /main/ }))
    expect(onCheckoutBranch).not.toHaveBeenCalled()
  })
})
