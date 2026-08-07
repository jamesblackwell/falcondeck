import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'

import type { ProjectGroup, ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'

import { DesktopSidebar } from './Sidebar'

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: 'workspace-1',
    path: '/Users/james/falcondeck',
    status: 'ready',
    agents: [],
    default_provider: 'codex',
    models: [],
    collaboration_modes: [],
    account: { status: 'ready', label: 'ready' },
    current_thread_id: 'thread-1',
    connected_at: '2026-03-15T10:00:00Z',
    updated_at: '2026-03-15T10:00:00Z',
    last_error: null,
    ...overrides,
  }
}

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'thread-1',
    workspace_id: 'workspace-1',
    title: 'Main thread',
    provider: 'codex',
    native_session_id: null,
    status: 'idle',
    updated_at: '2026-03-15T10:00:00Z',
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    is_archived: false,
    is_pinned: false,
    goal: null,
    agent: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
    },
    attention: {
      level: 'none',
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    ...overrides,
  }
}

function renderSidebar(overrides: Partial<ComponentProps<typeof DesktopSidebar>> = {}) {
  const groups: ProjectGroup[] = [
    {
      workspace: workspace(),
      threads: [thread()],
    },
  ]

  const onRenameThread = vi.fn().mockResolvedValue(undefined)
  const onArchiveThread = vi.fn().mockResolvedValue(undefined)
  const onRemoveWorkspace = vi.fn().mockResolvedValue(undefined)

  render(
    <DesktopSidebar
      groups={groups}
      selectedWorkspaceId="workspace-1"
      selectedThreadId="thread-1"
      onSelectWorkspace={() => {}}
      onSelectThread={() => {}}
      onRenameThread={onRenameThread}
      onArchiveThread={onArchiveThread}
      onRemoveWorkspace={onRemoveWorkspace}
      {...overrides}
    />,
  )

  return { onRenameThread, onArchiveThread, onRemoveWorkspace }
}

describe('DesktopSidebar', () => {
  it('renames a thread from the right-click menu', async () => {
    const { onRenameThread } = renderSidebar()

    fireEvent.contextMenu(screen.getByText('Main thread'))

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const input = await screen.findByRole('textbox', { name: 'Thread title' })
    fireEvent.change(input, { target: { value: 'Renamed thread' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(onRenameThread).toHaveBeenCalledWith('workspace-1', 'thread-1', 'Renamed thread')
    })
  })

  it('archives a thread from the right-click menu', async () => {
    const { onArchiveThread } = renderSidebar()

    fireEvent.contextMenu(screen.getByText('Main thread'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }))

    await waitFor(() => {
      expect(onArchiveThread).toHaveBeenCalledWith('workspace-1', 'thread-1')
    })
  })

  it('removes a project from the right-click menu after confirmation', async () => {
    const { onRemoveWorkspace } = renderSidebar()

    fireEvent.contextMenu(screen.getByText('falcondeck'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove project' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Threads stay in the provider’s own history')
    expect(onRemoveWorkspace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(onRemoveWorkspace).toHaveBeenCalledWith('workspace-1')
    })
  })

  it('leaves the project menu out when removal is unavailable', () => {
    renderSidebar({ onRemoveWorkspace: undefined })

    fireEvent.contextMenu(screen.getByText('falcondeck'))

    expect(screen.queryByRole('menuitem', { name: 'Remove project' })).not.toBeInTheDocument()
  })
})
