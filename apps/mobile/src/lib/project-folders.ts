import type { ProjectFolderMutation } from '@falcondeck/client-core'
import { useRelayStore } from '@/store'

export async function mutateProjectFolder(
  mutation: ProjectFolderMutation,
): Promise<void> {
  // PreferencesUpdated is ordered with other clients' edits; an older RPC
  // response must not replace a newer preference event.
  await useRelayStore
    .getState()
    ._callRpc('preferences.update', { project_folder: mutation })
}
