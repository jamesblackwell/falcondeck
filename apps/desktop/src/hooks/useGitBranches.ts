import { useCallback, useEffect, useRef, useState } from 'react'

import type { GitBranchesResponse, GitStatusResponse } from '@falcondeck/client-core'

type DaemonApi = {
  gitBranches: (workspaceId: string) => Promise<GitBranchesResponse>
  gitCheckout: (workspaceId: string, branch: string, create?: boolean) => Promise<GitBranchesResponse>
  gitStatus: (workspaceId: string) => Promise<GitStatusResponse>
}

/**
 * Branch state for the new-thread context bar. Pass a null api or workspace to
 * disable it (thread already selected, remote host, settings open) — the bar
 * unmounts and no requests are made. Non-repo folders resolve to null branches
 * rather than an error, so the chip simply stays hidden there.
 */
export function useGitBranches(
  api: DaemonApi | null,
  workspaceId: string | null,
  refreshTrigger: number,
) {
  const [branches, setBranches] = useState<GitBranchesResponse | null>(null)
  const [uncommittedCount, setUncommittedCount] = useState<number | null>(null)
  const [isCheckoutPending, setIsCheckoutPending] = useState(false)
  // Responses only write the state they were requested for; a slow reply for
  // the previous workspace must not overwrite the new one.
  const generationRef = useRef(0)

  const fetchBranches = useCallback(async () => {
    if (!api || !workspaceId) {
      setBranches(null)
      setUncommittedCount(null)
      return
    }
    const generation = ++generationRef.current
    try {
      const [nextBranches, status] = await Promise.all([
        api.gitBranches(workspaceId),
        api.gitStatus(workspaceId).catch(() => null),
      ])
      if (generationRef.current !== generation) return
      setBranches(nextBranches)
      setUncommittedCount(status ? status.entries.length : null)
    } catch {
      if (generationRef.current !== generation) return
      setBranches(null)
      setUncommittedCount(null)
    }
  }, [api, workspaceId])

  useEffect(() => {
    // A stale list from the previous workspace must not stay clickable while
    // the new one loads.
    setBranches(null)
    setUncommittedCount(null)
    void fetchBranches()
  }, [fetchBranches])

  useEffect(() => {
    if (refreshTrigger > 0) void fetchBranches()
  }, [fetchBranches, refreshTrigger])

  const checkout = useCallback(
    async (branch: string, create: boolean) => {
      if (!api || !workspaceId) return
      setIsCheckoutPending(true)
      try {
        const next = await api.gitCheckout(workspaceId, branch, create)
        setBranches(next)
      } finally {
        setIsCheckoutPending(false)
      }
    },
    [api, workspaceId],
  )

  return { branches, uncommittedCount, isCheckoutPending, checkout, refresh: fetchBranches }
}
