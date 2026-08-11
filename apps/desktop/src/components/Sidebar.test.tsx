import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  it('shows pinned chats above projects without duplicating them in their project', () => {
    const onSelectThread = vi.fn()
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({
              id: 'pinned-thread',
              title: 'Pinned chat',
              is_pinned: true,
            }),
            thread({ id: 'regular-thread', title: 'Project chat' }),
          ],
        },
      ],
      selectedThreadId: 'regular-thread',
      onSelectThread,
    })

    const pinnedSection = screen.getByRole('region', { name: 'Pinned' })
    const projectsSection = screen.getByRole('region', { name: 'Projects' })

    expect(pinnedSection.compareDocumentPosition(projectsSection)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(within(pinnedSection).getByText('Pinned chat')).toBeInTheDocument()
    expect(within(projectsSection).queryByText('Pinned chat')).not.toBeInTheDocument()
    expect(within(projectsSection).getByText('Project chat')).toBeInTheDocument()
    expect(screen.getAllByText('Pinned chat')).toHaveLength(1)

    fireEvent.click(within(pinnedSection).getByText('Pinned chat'))
    expect(onSelectThread).toHaveBeenCalledWith('workspace-1', 'pinned-thread')
  })

  it('sorts each project’s chats by name when asked', () => {
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({ id: 'thread-b', title: 'Beta chat', updated_at: '2026-03-15T12:00:00Z' }),
            thread({ id: 'thread-a', title: 'Alpha chat', updated_at: '2026-03-15T09:00:00Z' }),
          ],
        },
      ],
      threadSort: 'alphabetical',
      onThreadSortChange: vi.fn(),
    })

    const projectsSection = screen.getByRole('region', { name: 'Projects' })
    const alpha = within(projectsSection).getByText('Alpha chat')
    const beta = within(projectsSection).getByText('Beta chat')
    expect(alpha.compareDocumentPosition(beta)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('puts chats waiting on the user first when sorting by priority', () => {
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({ id: 'thread-idle', title: 'Idle chat', updated_at: '2026-03-15T12:00:00Z' }),
            thread({
              id: 'thread-waiting',
              title: 'Waiting chat',
              updated_at: '2026-03-15T09:00:00Z',
              attention: {
                level: 'awaiting_response',
                badge_label: 'Awaiting response',
                unread: false,
                pending_approval_count: 1,
                pending_question_count: 0,
                last_agent_activity_seq: 0,
                last_read_seq: 0,
              },
            }),
          ],
        },
      ],
      threadSort: 'priority',
      onThreadSortChange: vi.fn(),
    })

    const projectsSection = screen.getByRole('region', { name: 'Projects' })
    const waiting = within(projectsSection).getByText('Waiting chat')
    const idle = within(projectsSection).getByText('Idle chat')
    expect(waiting.compareDocumentPosition(idle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('trails an out-of-window selected chat below the five most recent', () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      thread({
        id: `thread-${index}`,
        title: `Chat ${index}`,
        // Descending recency: Chat 0 is newest, Chat 7 is oldest.
        updated_at: `2026-03-${String(20 - index).padStart(2, '0')}T10:00:00Z`,
      }),
    )

    renderSidebar({
      groups: [{ workspace: workspace(), threads }],
      selectedThreadId: 'thread-7',
    })

    const projectsSection = screen.getByRole('region', { name: 'Projects' })
    for (const index of [0, 1, 2, 3, 4]) {
      expect(within(projectsSection).getByText(`Chat ${index}`)).toBeInTheDocument()
    }
    // The chats between the window and the selection stay hidden.
    expect(within(projectsSection).queryByText('Chat 5')).not.toBeInTheDocument()
    expect(within(projectsSection).queryByText('Chat 6')).not.toBeInTheDocument()
    expect(within(projectsSection).getByText('Chat 7')).toBeInTheDocument()

    fireEvent.click(within(projectsSection).getByText('Show more'))
    expect(within(projectsSection).getByText('Chat 5')).toBeInTheDocument()
    expect(within(projectsSection).getAllByText('Chat 7')).toHaveLength(1)
  })

  it('keeps the five most recent chats visible after the selection moves back in', () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      thread({
        id: `thread-${index}`,
        title: `Chat ${index}`,
        updated_at: `2026-03-${String(20 - index).padStart(2, '0')}T10:00:00Z`,
      }),
    )
    const groups: ProjectGroup[] = [{ workspace: workspace(), threads }]

    const { rerender } = render(
      <DesktopSidebar
        groups={groups}
        selectedWorkspaceId="workspace-1"
        selectedThreadId="thread-7"
        onSelectWorkspace={() => {}}
        onSelectThread={() => {}}
      />,
    )

    rerender(
      <DesktopSidebar
        groups={groups}
        selectedWorkspaceId="workspace-1"
        selectedThreadId="thread-1"
        onSelectWorkspace={() => {}}
        onSelectThread={() => {}}
      />,
    )

    const projectsSection = screen.getByRole('region', { name: 'Projects' })
    for (const index of [0, 1, 2, 3, 4]) {
      expect(within(projectsSection).getByText(`Chat ${index}`)).toBeInTheDocument()
    }
    expect(within(projectsSection).queryByText('Chat 7')).not.toBeInTheDocument()
  })

  it('reorders projects by dragging across the project rows', () => {
    const onWorkspaceOrderChange = vi.fn().mockResolvedValue(undefined)
    const first = workspace({ id: 'workspace-a', path: '/Users/james/alpha' })
    const second = workspace({ id: 'workspace-b', path: '/Users/james/beta' })

    renderSidebar({
      groups: [
        { workspace: first, threads: [thread({ workspace_id: first.id })] },
        { workspace: second, threads: [thread({ workspace_id: second.id, id: 'thread-b' })] },
      ],
      onWorkspaceOrderChange,
    })

    const firstRow = document.querySelector('[data-workspace-drag-id="workspace-a"]')
    const secondRow = document.querySelector('[data-workspace-drag-id="workspace-b"]')
    if (!(firstRow instanceof HTMLElement) || !(secondRow instanceof HTMLElement)) {
      throw new Error('Expected draggable workspace rows')
    }
    Object.defineProperty(firstRow, 'setPointerCapture', { value: vi.fn() })
    Object.defineProperty(firstRow, 'hasPointerCapture', { value: vi.fn(() => true) })
    Object.defineProperty(firstRow, 'releasePointerCapture', { value: vi.fn() })
    Object.defineProperty(secondRow, 'getBoundingClientRect', {
      value: () => ({ top: 100, bottom: 140, height: 40, left: 0, right: 300, width: 300 }),
    })

    fireEvent.pointerDown(firstRow, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    })
    fireEvent.pointerMove(firstRow, {
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 150,
    })
    expect(document.querySelector('[data-workspace-drop-indicator="true"]')).toBeInTheDocument()
    fireEvent.pointerUp(firstRow, { pointerId: 1, isPrimary: true, button: 0 })

    expect(onWorkspaceOrderChange).toHaveBeenCalledWith(['workspace-b', 'workspace-a'])
    expect(screen.getByText('beta').compareDocumentPosition(screen.getByText('alpha'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('changes the chat sort from the Projects heading menu', async () => {
    const onThreadSortChange = vi.fn()
    renderSidebar({ threadSort: 'last_updated', onThreadSortChange })

    fireEvent.click(screen.getByRole('button', { name: 'Sort chats' }))

    const menu = await screen.findByRole('menu', { name: 'Sort chats by' })
    expect(within(menu).getByRole('menuitemradio', { name: 'Last updated' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(menu).getByRole('menuitemradio', { name: 'Name' })).toHaveAttribute(
      'aria-checked',
      'false',
    )

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Name' }))
    expect(onThreadSortChange).toHaveBeenCalledWith('alphabetical')
  })

  it('leaves the sort menu out when no sort handler is provided', () => {
    renderSidebar()

    expect(screen.queryByRole('button', { name: 'Sort chats' })).not.toBeInTheDocument()
  })

  it('collapses a project to hide its threads, and selects it on the way back open', () => {
    const onSelectWorkspace = vi.fn()
    renderSidebar({ onSelectWorkspace })

    const toggle = screen.getByRole('button', { name: 'falcondeck' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Main thread')).not.toBeInTheDocument()
    // Collapsing is not a selection change, so nothing should be re-selected.
    expect(onSelectWorkspace).not.toHaveBeenCalled()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Main thread')).toBeInTheDocument()
    expect(onSelectWorkspace).toHaveBeenCalledWith('workspace-1', 'thread-1')
  })

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
    expect(dialog).toHaveTextContent('deletes its isolated copy')
    expect(dialog).toHaveTextContent('/Users/james/.falcondeck/worktrees/fix-login')
    expect(dialog).toHaveTextContent('committed work stays on branch fd/fix-login')
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
