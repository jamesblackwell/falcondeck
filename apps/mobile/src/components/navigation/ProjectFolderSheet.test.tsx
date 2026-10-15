import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectFolder } from '@falcondeck/client-core'
import { cleanup, renderComponent, textOf } from '@/test/render'
import { mutateProjectFolder } from '@/lib/project-folders'
import {
  ProjectFolderPickerSheet,
  ProjectFolderSheet,
} from './ProjectFolderSheet'

vi.mock('@/lib/project-folders', () => ({
  mutateProjectFolder: vi.fn().mockResolvedValue(undefined),
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const folder: ProjectFolder = {
  id: 'chores',
  workspace_id: 'project',
  name: 'Chores',
  collapsed: false,
  thread_ids: ['task'],
}

describe('mobile folder controls', () => {
  it('creates a named folder through the synced mutation', async () => {
    const close = vi.fn()
    const view = renderComponent(
      <ProjectFolderSheet workspaceId="project" onClose={close} />,
    )
    act(() =>
      view.root
        .findByProps({ accessibilityLabel: 'Folder name' })
        .props.onChangeText('  Research  '),
    )
    await act(async () =>
      view.root.findByProps({ label: 'Create' }).props.onPress(),
    )
    expect(mutateProjectFolder).toHaveBeenCalledWith({
      action: 'create',
      workspace_id: 'project',
      name: 'Research',
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('renames a folder through its long-press options', async () => {
    const view = renderComponent(
      <ProjectFolderSheet
        workspaceId="project"
        folder={folder}
        onClose={vi.fn()}
      />,
    )
    act(() =>
      view.root
        .findByProps({ accessibilityLabel: 'Rename folder' })
        .props.onPress(),
    )
    act(() =>
      view.root
        .findByProps({ accessibilityLabel: 'Folder name' })
        .props.onChangeText('Maintenance'),
    )
    await act(async () =>
      view.root.findByProps({ label: 'Save' }).props.onPress(),
    )
    expect(mutateProjectFolder).toHaveBeenCalledWith({
      action: 'rename',
      workspace_id: 'project',
      folder_id: 'chores',
      name: 'Maintenance',
    })
  })

  it('deletes only the folder and explains where its tasks go', async () => {
    const view = renderComponent(
      <ProjectFolderSheet
        workspaceId="project"
        folder={folder}
        onClose={vi.fn()}
      />,
    )
    expect(textOf(view)).toContain('Tasks return to the project root')
    await act(async () =>
      view.root
        .findByProps({ accessibilityLabel: 'Delete folder' })
        .props.onPress(),
    )
    expect(mutateProjectFolder).toHaveBeenCalledWith({
      action: 'delete',
      workspace_id: 'project',
      folder_id: 'chores',
    })
  })

  it('moves tasks back to the project without offering another project’s folders', async () => {
    const close = vi.fn()
    const view = renderComponent(
      <ProjectFolderPickerSheet
        workspaceId="project"
        threadId="task"
        folders={[
          folder,
          { ...folder, id: 'foreign', name: 'Foreign', workspace_id: 'other' },
        ]}
        onClose={close}
      />,
    )
    expect(textOf(view)).not.toContain('Foreign')
    await act(async () =>
      view.root
        .findByProps({ accessibilityLabel: 'Project root' })
        .props.onPress(),
    )
    expect(mutateProjectFolder).toHaveBeenCalledWith({
      action: 'move_thread',
      workspace_id: 'project',
      thread_id: 'task',
      folder_id: null,
    })
    expect(close).toHaveBeenCalledOnce()
  })
})
