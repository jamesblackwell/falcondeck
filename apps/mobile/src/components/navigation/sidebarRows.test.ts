import { describe, expect, it } from 'vitest'

import { workspace, thread } from '@/test/factories'

import { buildSidebarRows } from './sidebarRows'

describe('buildSidebarRows', () => {
  it('creates workspace and thread rows in order', () => {
    const rows = buildSidebarRows([
      {
        workspace: workspace({ id: 'w1', path: '/tmp/project-one' }),
        threads: [
          thread({ id: 't1', workspace_id: 'w1' }),
          thread({ id: 't2', workspace_id: 'w1' }),
        ],
      },
    ])

    expect(rows).toEqual([
      {
        key: 'workspace:w1',
        type: 'workspace',
        workspaceId: 'w1',
        workspaceName: 'project-one',
      },
      expect.objectContaining({
        key: 'thread:t1',
        type: 'thread',
        workspaceId: 'w1',
      }),
      expect.objectContaining({
        key: 'thread:t2',
        type: 'thread',
        workspaceId: 'w1',
      }),
    ])
  })

  it('falls back to the full workspace path when no basename exists', () => {
    const rows = buildSidebarRows([
      {
        workspace: workspace({ id: 'w1', path: '' }),
        threads: [],
      },
    ])

    expect(rows[0]).toEqual({
      key: 'workspace:w1',
      type: 'workspace',
      workspaceId: 'w1',
      workspaceName: 'Workspace',
    })
  })
})
