import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  GitStatusResponse,
  ShipThreadMode,
  ShipThreadResponse,
  ThreadSummary,
} from '@falcondeck/client-core'

type ShipApi = {
  gitStatus: (workspaceId: string, threadId?: string | null) => Promise<GitStatusResponse>
  shipThread: (
    workspaceId: string,
    threadId: string,
    mode: ShipThreadMode,
  ) => Promise<ShipThreadResponse>
}

/** Structurally matches the `toast` from `@falcondeck/ui`'s `useToast`. */
type ShipToast = (toast: {
  variant: 'default' | 'success' | 'warning' | 'danger'
  title: string
  description?: string
}) => void

export type UseShipThreadOptions = {
  api: ShipApi | null
  workspaceId: string | null
  thread: ThreadSummary | null
  toast: ShipToast
  /** Opens a created pull request in the system browser. */
  openUrl: (url: string) => Promise<void>
  /** Called after a successful ship so git views re-read the new state. */
  onShipped?: () => void
}

function describeSuccess(result: ShipThreadResponse) {
  const committed = result.committed ? 'Committed leftover changes, then ' : ''
  switch (result.mode) {
    case 'merge':
      // A merge lands locally even when the push fails; say which happened.
      return result.pushed
        ? `${committed}merged ${result.branch} into ${result.base} and pushed.`
        : `${committed}merged ${result.branch} into ${result.base}, but could not push to origin. Push ${result.base} yourself when you can.`
    case 'draft_pr':
      return `${committed}opened a draft pull request into ${result.base}.`
    default:
      return `${committed}opened a pull request into ${result.base}.`
  }
}

/**
 * Drives the isolated-thread Merge control: runs the chosen mode, reports the
 * outcome, and tracks whether the project folder is too dirty to merge into.
 *
 * The dirty check is advisory only — the daemon refuses a dirty merge on its
 * own. Knowing up front just lets the menu disable the item and say why.
 */
export function useShipThread({
  api,
  workspaceId,
  thread,
  toast,
  openUrl,
  onShipped,
}: UseShipThreadOptions) {
  const [pending, setPending] = useState(false)
  const [projectFolderDirty, setProjectFolderDirty] = useState(false)
  const isIsolated = Boolean(thread?.variant)
  // A slow reply for a thread we have since left must not disable the menu for
  // whatever is on screen now.
  const generationRef = useRef(0)

  useEffect(() => {
    if (!api || !workspaceId || !isIsolated) {
      setProjectFolderDirty(false)
      return
    }
    const generation = ++generationRef.current
    // No thread id: this asks about the project folder itself, which is what
    // "Merge and push" would write into.
    api
      .gitStatus(workspaceId)
      .then((status) => {
        if (generationRef.current !== generation) return
        setProjectFolderDirty(status.entries.length > 0)
      })
      .catch(() => {
        // Fall back to letting the user try; the daemon refuses if it must.
        if (generationRef.current !== generation) return
        setProjectFolderDirty(false)
      })
  }, [api, isIsolated, workspaceId, thread?.id])

  const ship = useCallback(
    async (mode: ShipThreadMode) => {
      if (!api || !workspaceId || !thread) return
      setPending(true)
      try {
        const result = await api.shipThread(workspaceId, thread.id, mode)
        const incomplete = result.mode === 'merge' && !result.pushed
        toast({
          variant: incomplete ? 'warning' : 'success',
          title: result.mode === 'merge' ? 'Merged' : 'Pull request created',
          description: describeSuccess(result),
        })
        if (result.url) await openUrl(result.url)
        onShipped?.()
      } catch (error) {
        toast({
          variant: 'danger',
          title: mode === 'merge' ? 'Could not merge' : 'Could not create a pull request',
          description:
            error instanceof Error ? error.message : 'The daemon did not say why this failed.',
        })
      } finally {
        setPending(false)
      }
    },
    [api, onShipped, openUrl, thread, toast, workspaceId],
  )

  return { ship, pending, projectFolderDirty }
}
