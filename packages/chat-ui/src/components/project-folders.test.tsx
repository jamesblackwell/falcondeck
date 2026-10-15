import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  normalizeDaemonSnapshot,
  type ProjectFolder,
} from '@falcondeck/client-core'
import { WorkspaceSidebar } from './workspace-sidebar'

const folder: ProjectFolder = {
  id: 'chores',
  workspace_id: 'project',
  name: 'Chores',
  collapsed: false,
  thread_ids: ['background'],
}
function setup(
  folders = [folder],
  mutate = vi.fn().mockResolvedValue(undefined),
) {
  const snapshot = normalizeDaemonSnapshot({
    workspaces: [{ id: 'project', path: '/projects/demo' }],
    threads: [
      {
        id: 'background',
        workspace_id: 'project',
        title: 'Background',
        status: 'idle',
      },
      {
        id: 'root',
        workspace_id: 'project',
        title: 'Main task',
        status: 'idle',
      },
    ],
  })
  const props = {
    groups: [{ workspace: snapshot.workspaces[0], threads: snapshot.threads }],
    selectedWorkspaceId: 'project',
    selectedThreadId: null,
    onSelectWorkspace: vi.fn(),
    onSelectThread: vi.fn(),
    onRenameThread: vi.fn(),
    projectFolders: folders,
    onProjectFolderMutation: mutate,
    onNewThreadInFolder: vi.fn().mockResolvedValue(undefined),
  }
  const view = render(<WorkspaceSidebar {...props} />)
  return { ...view, mutate, props }
}

describe('project folder sidebar', () => {
  it('creates a named folder from the project hover control', async () => {
    const { mutate } = setup()
    fireEvent.click(
      screen.getByRole('button', { name: 'Create folder in demo' }),
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
      target: { value: '  Research  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        action: 'create',
        workspace_id: 'project',
        name: 'Research',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('folds assigned tasks and keeps root tasks visible', () => {
    const { rerender, props } = setup([{ ...folder, collapsed: true }])
    expect(screen.queryByRole('button', { name: 'Background' })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Main task' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Chores/ }))
    expect(props.onProjectFolderMutation).toHaveBeenCalledWith({
      action: 'set_collapsed',
      workspace_id: 'project',
      folder_id: 'chores',
      collapsed: false,
    })
    rerender(<WorkspaceSidebar {...props} projectFolders={[folder]} />)
    expect(
      screen.getByRole('button', { name: 'Background' }),
    ).toBeInTheDocument()
  })

  it('keeps project pins above folders and ordinary tasks below', () => {
    const { props, rerender } = setup()
    const tasks = props.groups[0].threads.map((task) =>
      task.id === 'root' ? { ...task, is_pinned_in_project: true } : task,
    )
    tasks.push({ ...tasks[0], id: 'ordinary', title: 'Ordinary task' })
    rerender(
      <WorkspaceSidebar
        {...props}
        groups={[{ ...props.groups[0], threads: tasks }]}
      />,
    )
    const names = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    expect(names.indexOf('Main task')).toBeLessThan(names.indexOf('Chores'))
    expect(names.indexOf('Chores')).toBeLessThan(names.indexOf('Ordinary task'))
  })

  it('moves a dragged task into a folder and back onto its project header', () => {
    const { mutate, props } = setup()
    // jsdom has no layout, so point the hit test at the intended target.
    let pointerTarget: Element | null = null
    document.elementFromPoint = vi.fn(() => pointerTarget)
    const drag = (rowName: string, target: Element) => {
      const row = screen.getByRole('button', { name: rowName }).parentElement!
      fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
      pointerTarget = target
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 40 })
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 40 })
      fireEvent.click(row)
    }

    drag('Main task', document.querySelector('[data-project-folder="chores"]')!)
    expect(mutate).toHaveBeenCalledWith({
      action: 'move_thread',
      workspace_id: 'project',
      thread_id: 'root',
      folder_id: 'chores',
    })
    // Releasing the drag must not also open the dragged task.
    expect(props.onSelectThread).not.toHaveBeenCalled()

    drag(
      'Background',
      screen.getByRole('button', { name: 'demo' }).closest('[data-task-drop-workspace]')!,
    )
    expect(mutate).toHaveBeenLastCalledWith({
      action: 'move_thread',
      workspace_id: 'project',
      thread_id: 'background',
      folder_id: null,
    })
  })

  it('treats a short press as a click and Escape as a cancelled drag', () => {
    const { mutate, props } = setup()
    document.elementFromPoint = vi.fn(() =>
      document.querySelector('[data-project-folder="chores"]'),
    )
    const row = screen.getByRole('button', { name: 'Main task' }).parentElement!
    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 11, clientY: 11 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    fireEvent.click(row)
    expect(props.onSelectThread).toHaveBeenCalledWith('project', 'root')

    fireEvent.pointerDown(row, { pointerId: 2, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 10, clientY: 60 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('offers a keyboard-accessible move menu and project root destination', async () => {
    const { mutate } = setup()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Background' }), {
      clientX: 100,
      clientY: 100,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to folder…' }))
    expect(
      screen.getByRole('dialog', { name: 'Move task' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Project root' }))
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        action: 'move_thread',
        workspace_id: 'project',
        thread_id: 'background',
        folder_id: null,
      }),
    )
  })

  it('renames and dissolves folders through their context menu', async () => {
    const { mutate } = setup()
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Chores/ }), {
      clientX: 40,
      clientY: 40,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename folder' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Maintenance' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mutate).toHaveBeenCalledWith({
      action: 'rename',
      workspace_id: 'project',
      folder_id: 'chores',
      name: 'Maintenance',
    })
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Chores/ }), {
      clientX: 40,
      clientY: 40,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete folder' }))
    expect(mutate).toHaveBeenLastCalledWith({
      action: 'delete',
      workspace_id: 'project',
      folder_id: 'chores',
    })
  })

  it('keeps the entered name and displays validation errors', async () => {
    setup(
      [folder],
      vi
        .fn()
        .mockRejectedValue(new Error('A folder with that name already exists')),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Create folder in demo' }),
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
      target: { value: 'Chores' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists')
    expect(screen.getByRole('textbox')).toHaveValue('Chores')
  })

  it('starts new tasks in the chosen folder', () => {
    const { props } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'New task in Chores' }))
    expect(props.onNewThreadInFolder).toHaveBeenCalledWith('project', 'chores')
  })
})
