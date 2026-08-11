import { describe, expect, it } from 'vitest'

import type { ThreadSummary, WorkspaceSummary } from './types'
import { buildProjectGroups } from './grouping'

function workspace(id: string, path: string) {
  return { id, path } as WorkspaceSummary
}

function thread(id: string, workspaceId: string) {
  return { id, workspace_id: workspaceId, is_archived: false } as ThreadSummary
}

describe('buildProjectGroups', () => {
  it('keeps saved projects first and falls back alphabetically for new projects', () => {
    const groups = buildProjectGroups(
      [
        workspace('new', '/projects/zeta'),
        workspace('saved-b', '/projects/beta'),
        workspace('saved-a', '/projects/alpha'),
      ],
      [thread('thread-a', 'saved-a')],
      ['saved-a', 'saved-b'],
    )

    expect(groups.map((group) => group.workspace.id)).toEqual(['saved-a', 'saved-b', 'new'])
  })
})
