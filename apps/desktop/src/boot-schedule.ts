import type { WorkspaceKind } from '@falcondeck/client-core'

/**
 * Git branch/status reads exist for the new-thread composer only. They have
 * to wait until the first daemon snapshot confirms that no thread is selected;
 * a restored thread id has no thread object yet, and querying in that gap
 * races snapshot generation and the selected thread's detail read.
 */
export function shouldQueryNewThreadGit(input: {
  snapshotReady: boolean
  selectedThreadId: string | null
  workspaceKind: WorkspaceKind | null | undefined
  remoteWorkspace: boolean
  settingsOpen: boolean
}): boolean {
  if (!input.snapshotReady || input.selectedThreadId) return false
  if (input.workspaceKind === 'casual') return false
  if (input.remoteWorkspace || input.settingsOpen) return false
  return true
}
