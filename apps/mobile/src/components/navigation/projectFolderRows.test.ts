import { describe, expect, it } from 'vitest'
import type { ProjectFolder, ProjectGroup } from '@falcondeck/client-core'
import { workspace, thread } from '@/test/factories'
import { buildSidebarRows } from './sidebarRows'

const folder: ProjectFolder = {
  id: 'chores',
  workspace_id: 'workspace-1',
  name: 'Chores',
  collapsed: true,
  thread_ids: ['background'],
}
const groups: ProjectGroup[] = [
  {
    workspace: workspace(),
    threads: [thread({ id: 'root' }), thread({ id: 'background' })],
  },
]
const rows = (
  folders = [folder],
  collapsed = new Set<string>(),
  counts = new Map<string, number>(),
  source = groups,
) =>
  buildSidebarRows(
    source,
    collapsed,
    counts,
    null,
    'last_updated',
    false,
    false,
    {},
    {},
    false,
    source,
    folders,
  )

describe('mobile folder rows', () => {
  it('keeps background tasks out of the project root and folds their rows', () => {
    const result = rows()
    expect(result.map((row) => row.key)).toEqual([
      'section:projects',
      'workspace:workspace-1',
      'folder:chores',
      'thread:background',
      'thread:root',
    ])
    expect(result.find((row) => row.key === 'thread:background')).toMatchObject(
      { type: 'thread', folderId: 'chores', isCollapsed: true },
    )
    expect(result[2]).toMatchObject({
      type: 'folder',
      count: 1,
      isCollapsed: false,
    })
  })
  it('follows synced folder state and the parent project disclosure', () => {
    expect(
      rows([{ ...folder, collapsed: false }]).find(
        (row) => row.key === 'thread:background',
      ),
    ).toMatchObject({ isCollapsed: false })
    const collapsed = rows(
      [{ ...folder, collapsed: false }],
      new Set(['workspace-1']),
    )
    expect(collapsed[2]).toMatchObject({ isCollapsed: true })
    expect(
      collapsed.find((row) => row.key === 'thread:background'),
    ).toMatchObject({ isCollapsed: true })
  })
  it('returns tasks to the root when a folder is deleted and preserves empty folders', () => {
    expect(
      rows([]).find((row) => row.key === 'thread:background'),
    ).not.toHaveProperty('folderId')
    expect(
      rows([{ ...folder, thread_ids: [] }]).find(
        (row) => row.key === 'folder:chores',
      ),
    ).toMatchObject({ type: 'folder', count: 0 })
  })
  it('places folders first, project-pinned tasks next, and ordinary root tasks last', () => {
    const source = [
      {
        ...groups[0],
        threads: [
          ...groups[0].threads,
          thread({ id: 'pin', is_pinned_in_project: true }),
        ],
      },
    ]
    const result = rows([folder], new Set(), new Map(), source)
    expect(result.map((row) => row.key)).toEqual([
      'section:projects',
      'workspace:workspace-1',
      'folder:chores',
      'thread:background',
      'thread:pin',
      'thread:root',
    ])
  })
  it('pages each folder independently of the project root', () => {
    const tasks = Array.from({ length: 8 }, (_, id) => thread({ id: `t${id}` }))
    const source = [{ workspace: workspace(), threads: tasks }]
    const folders = [
      { ...folder, collapsed: false, thread_ids: tasks.map((task) => task.id) },
    ]
    expect(rows(folders, new Set(), new Map(), source).at(-1)).toMatchObject({
      type: 'overflow',
      folderId: 'chores',
      hiddenCount: 3,
    })
    expect(
      rows(folders, new Set(), new Map([['folder:chores', 15]]), source).at(-1),
    ).toMatchObject({ hiddenCount: 0, isExpanded: true })
  })
})
