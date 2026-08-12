import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const localWorkspace = workspace('ws-1', '/Users/dev/falcondeck')
const otherLocal = workspace('ws-2', '/Users/dev/lucidpic')
const remoteWorkspace = workspace('ws-remote', '/home/forge/projects/quizgecko')

const baseProps = {
  workspaces: [localWorkspace, otherLocal],
  selectedWorkspace: localWorkspace,
  onSelectWorkspace: vi.fn(),
  selectedIsolation: 'project_folder' as const,
  onIsolationChange: vi.fn(),
}

describe('ComposerContextBar', () => {
  it('shows the project, location, isolation, and branch chips for a git workspace', () => {
    render(
      <ComposerContextBar
        {...baseProps}
        branches={{ current: 'main', branches: ['main', 'codex/ui-sharing-merge'] }}
        uncommittedCount={22}
        onCheckoutBranch={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Project' })).toHaveTextContent('falcondeck')
    expect(screen.getByText('Local')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Work in' })).toHaveTextContent('Project folder')
    expect(screen.getByRole('button', { name: 'Git branch' })).toHaveTextContent('main')
  })

  it('labels remote projects with the host name and a host location chip', () => {
    render(
      <ComposerContextBar
        {...baseProps}
        workspaces={[localWorkspace, remoteWorkspace]}
        selectedWorkspace={remoteWorkspace}
        workspaceHosts={{
          'ws-remote': { name: 'quizgecko-ops-2', connected: true },
        }}
        remoteHosts={[{ id: 'host-1', name: 'quizgecko-ops-2', connected: true }]}
        onAddRemoteProject={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Project' })).toHaveTextContent('quizgecko')
    // Location chip next to the project picker.
    expect(screen.getByTitle('Runs on quizgecko-ops-2')).toHaveTextContent('quizgecko-ops-2')

    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    expect(
      screen.getByRole('menuitemradio', { name: 'quizgecko quizgecko-ops-2' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'New remote project' })).toBeInTheDocument()
  })

  it('adds a remote project path on the selected host', async () => {
    const onAddRemoteProject = vi.fn().mockResolvedValue(undefined)
    render(
      <ComposerContextBar
        {...baseProps}
        remoteHosts={[{ id: 'host-1', name: 'quizgecko-ops-2', connected: true }]}
        onAddRemoteProject={onAddRemoteProject}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New remote project' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Remote project path' }), {
      target: { value: '/home/forge/projects/miner' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))

    await waitFor(() => {
      expect(onAddRemoteProject).toHaveBeenCalledWith('host-1', '/home/forge/projects/miner')
    })
  })

  it('offers New project for local folder pick when wired', () => {
    const onAddLocalProject = vi.fn()
    render(
      <ComposerContextBar {...baseProps} onAddLocalProject={onAddLocalProject} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New project' }))
    expect(onAddLocalProject).toHaveBeenCalled()
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

  it('filters long project and branch menus without changing short menus', () => {
    const workspaces = Array.from({ length: 9 }, (_, index) =>
      workspace(`ws-${index}`, `/Users/dev/project-${index}`),
    )
    render(
      <ComposerContextBar
        {...baseProps}
        workspaces={workspaces}
        selectedWorkspace={workspaces[0] ?? null}
        branches={{
          current: 'main',
          branches: ['main', 'develop', 'release', 'staging', 'feature/auth', 'feature/chat', 'fix/ios', 'fix/web', 'docs/readme'],
        }}
        onCheckoutBranch={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    const projectSearch = screen.getByRole('searchbox', { name: 'Search projects' })
    fireEvent.change(projectSearch, { target: { value: 'project-8' } })
    expect(screen.getByRole('menuitemradio', { name: /project-8/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: /project-1/ })).not.toBeInTheDocument()

    fireEvent.keyDown(projectSearch, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Git branch' }))
    const branchSearch = screen.getByRole('searchbox', { name: 'Search branches' })
    fireEvent.change(branchSearch, { target: { value: 'ios' } })
    expect(screen.getByRole('menuitemradio', { name: 'fix/ios' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: 'fix/web' })).not.toBeInTheDocument()
  })
})
