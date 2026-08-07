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

function renderSidebar(
  overrides: Partial<ComponentProps<typeof DesktopSidebar>> = {},
  threadOverrides: Partial<ThreadSummary> = {},
) {
  const groups: ProjectGroup[] = [
    {
      workspace: workspace(),
      threads: [thread(threadOverrides)],
    },
  ]

  const onRenameThread = vi.fn().mockResolvedValue(undefined)
  const onArchiveThread = vi.fn().mockResolvedValue(undefined)
  const onDeleteThread = vi.fn().mockResolvedValue(undefined)
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
      onDeleteThread={onDeleteThread}
      onRemoveWorkspace={onRemoveWorkspace}
      {...overrides}
    />,
  )

  return { onRenameThread, onArchiveThread, onDeleteThread, onRemoveWorkspace }
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

  it('deletes a thread from the right-click menu after confirmation', async () => {
    const { onDeleteThread } = renderSidebar()

    fireEvent.contextMenu(screen.getByText('Main thread'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Archiving keeps it out of the way')
    expect(onDeleteThread).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(onDeleteThread).toHaveBeenCalledWith('workspace-1', 'thread-1')
    })
  })

  it('warns that deleting an isolated thread takes its checkout with it', async () => {
    renderSidebar(
      {},
      {
        variant: {
          slug: 'fix-login',
          path: '/Users/james/.falcondeck/worktrees/fix-login',
          branch: 'fd/fix-login',
          kind: 'worktree',
        },
      },
    )

    fireEvent.contextMenu(screen.getByText('Main thread'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('deletes its isolated worktree')
    expect(dialog).toHaveTextContent('/Users/james/.falcondeck/worktrees/fix-login')
  })

  it('leaves the delete item out when deletion is unavailable', () => {
    renderSidebar({ onDeleteThread: undefined })

    fireEvent.contextMenu(screen.getByText('Main thread'))

    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
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

  it('focuses the context menu and moves through it with the arrow keys', async () => {
    renderSidebar()

    fireEvent.contextMenu(screen.getByText('Main thread'))
    const menu = await screen.findByRole('menu')
    const items = screen.getAllByRole('menuitem')

    // The menu opens from a right-click, so nothing moves focus into it
    // unless the menu does it itself.
    expect(items[0]).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(items[0]).toHaveFocus()

    // Wraps, so ArrowUp from the first item lands on the last.
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(items[items.length - 1]).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'Home' })
    expect(items[0]).toHaveFocus()
  })

  it('moves focus into the delete dialog rather than leaving it on the body', async () => {
    renderSidebar()

    fireEvent.contextMenu(screen.getByText('Main thread'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('leaves the project menu out when removal is unavailable', () => {
    renderSidebar({ onRemoveWorkspace: undefined })

    fireEvent.contextMenu(screen.getByText('falcondeck'))

    expect(screen.queryByRole('menuitem', { name: 'Remove project' })).not.toBeInTheDocument()
  })
})
