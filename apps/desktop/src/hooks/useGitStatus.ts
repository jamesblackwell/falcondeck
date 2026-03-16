import { useCallback, useEffect, useRef, useState } from 'react'

import type { GitStatusResponse } from '@falcondeck/client-core'

type DaemonApi = {
  gitStatus: (workspaceId: string) => Promise<GitStatusResponse>
}

export function useGitStatus(
  api: DaemonApi | null,
  workspaceId: string | null,
  refreshTrigger: number,
) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialFetchDone = useRef(false)

  const fetchStatus = useCallback(async () => {
    if (!api || !workspaceId) {
      setStatus(null)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const result = await api.gitStatus(workspaceId)
      setStatus(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch git status')
    } finally {
      setIsLoading(false)
    }
  }, [api, workspaceId])

  // Single effect: initial fetch + debounced refresh
  useEffect(() => {
    if (!api || !workspaceId) {
      setStatus(null)
      initialFetchDone.current = false
      return
    }

    if (!initialFetchDone.current) {
      initialFetchDone.current = true
      void fetchStatus()
      return
    }

    // Subsequent triggers are debounced
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void fetchStatus()
    }, 500)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [api, workspaceId, refreshTrigger, fetchStatus])

  return { status, isLoading, error, refresh: fetchStatus }
}
