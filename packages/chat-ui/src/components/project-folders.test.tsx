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
    const { mutate } = setup()
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(
      screen.getByRole('button', { name: 'Main task' }).closest('[draggable]')!,
      { dataTransfer },
    )
    const target = document.querySelector('[data-project-folder="chores"]')!
    fireEvent.dragOver(target, { dataTransfer })
    fireEvent.drop(target, { dataTransfer })
    expect(mutate).toHaveBeenCalledWith({
      action: 'move_thread',
      workspace_id: 'project',
      thread_id: 'root',
      folder_id: 'chores',
    })
    fireEvent.dragStart(
      screen
        .getByRole('button', { name: 'Background' })
        .closest('[draggable]')!,
      { dataTransfer },
    )
    const projectHeader = screen.getByRole('button', {
      name: 'demo',
    }).parentElement!
    fireEvent.dragOver(projectHeader, { dataTransfer })
    fireEvent.drop(projectHeader, { dataTransfer })
    expect(mutate).toHaveBeenLastCalledWith({
      action: 'move_thread',
      workspace_id: 'project',
      thread_id: 'background',
      folder_id: null,
    })
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
