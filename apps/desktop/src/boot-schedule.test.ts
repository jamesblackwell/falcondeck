import { describe, expect, it } from 'vitest'

import { shouldQueryNewThreadGit } from './boot-schedule'

describe('shouldQueryNewThreadGit', () => {
  const ready = {
    snapshotReady: true,
    selectedThreadId: null,
    workspaceKind: 'project' as const,
    remoteWorkspace: false,
    settingsOpen: false,
  }

  it('waits until the snapshot shows a new local project thread', () => {
    expect(shouldQueryNewThreadGit(ready)).toBe(true)
    expect(shouldQueryNewThreadGit({ ...ready, snapshotReady: false })).toBe(false)
    expect(shouldQueryNewThreadGit({ ...ready, selectedThreadId: 'thread-1' })).toBe(false)
    expect(shouldQueryNewThreadGit({ ...ready, workspaceKind: 'casual' })).toBe(false)
    expect(shouldQueryNewThreadGit({ ...ready, remoteWorkspace: true })).toBe(false)
    expect(shouldQueryNewThreadGit({ ...ready, settingsOpen: true })).toBe(false)
  })
})