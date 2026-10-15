import { describe, expect, it } from 'vitest'
import {
  normalizeDaemonSnapshot,
  normalizePreferences,
  normalizeThreadSummary,
} from './normalization'
import {
  normalizeProjectFolders,
  partitionProjectFolders,
  projectFoldersForWorkspace,
} from './project-folders'
import { mergeSyncThreadPage } from './sync-index'
import type { ProjectFolder } from './types'

const folder: ProjectFolder = {
  id: 'chores',
  workspace_id: 'project',
  name: 'Chores',
  collapsed: true,
  thread_ids: ['background'],
}
const thread = (id: string) =>
  normalizeThreadSummary({ id, workspace_id: 'project', title: id })

describe('project folders', () => {
  it('accepts preferences from older daemons and keeps valid folder metadata on normalization', () => {
    expect(normalizePreferences({}).project_folders).toEqual([])
    expect(
      normalizePreferences({ project_folders: [folder] }).project_folders,
    ).toEqual([folder])
  })

  it('rejects malformed folders and assigns each task once per project', () => {
    const result = normalizeProjectFolders([
      null,
      {},
      {
        ...folder,
        name: '  Chores  ',
        thread_ids: ['background', 'background', 5],
      },
      folder,
      { ...folder, id: 'second', thread_ids: ['background', 'other'] },
      { ...folder, id: 'elsewhere', workspace_id: 'other-project' },
    ])
    expect(result.map((item) => [item.id, item.thread_ids])).toEqual([
      ['chores', ['background']],
      ['second', ['other']],
      ['elsewhere', ['background']],
    ])
    expect(result[0].name).toBe('Chores')
  })

  it('partitions tasks without changing their identity, order, or workspace', () => {
    const tasks = [thread('root'), thread('background'), thread('root-2')]
    const folders = [folder, { ...folder, id: 'empty', thread_ids: [] }]
    const result = partitionProjectFolders(tasks, folders)
    expect(result.root).toEqual([tasks[0], tasks[2]])
    expect(result.folders.map((item) => item.threads)).toEqual([[tasks[1]], []])
    expect(result.folders[0].threads[0]).toBe(tasks[1])
    expect(partitionProjectFolders(tasks, folders)).toBe(result)
    expect(projectFoldersForWorkspace(folders, 'project')).toBe(
      projectFoldersForWorkspace(folders, 'project'),
    )
  })

  it('keeps a completed folder page from deleting other carried project tasks', () => {
    const snapshot = normalizeDaemonSnapshot({
      threads: [thread('root')],
      sync_index: {
        token: 'index',
        counts: {},
        cursors: {},
        touched_threads: {},
        touched_views: {},
        catalog_touched: false,
        extensions_loaded: false,
        carried_threads: { root: true },
      },
    })
    const merged = mergeSyncThreadPage(
      snapshot,
      {
        token: 'index',
        workspace_id: 'project',
        threads: [thread('background')],
        next_cursor: null,
      },
      'folder:chores:last_updated',
      'folder',
    )
    expect(merged.threads.map((task) => task.id)).toEqual([
      'root',
      'background',
    ])
    expect(merged.sync_index?.carried_threads).toEqual({ root: true })
    expect(
      merged.sync_index?.cursors['project:folder:chores:last_updated'],
    ).toBeNull()
  })
})
