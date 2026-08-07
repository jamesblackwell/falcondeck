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
  const lastWorkspaceRef = useRef<string | null>(null)
  // Responses are only allowed to write the state they were requested for; a
  // slow reply for the previous workspace must not overwrite the new one.
  const generationRef = useRef(0)

  const fetchStatus = useCallback(async () => {
    if (!api || !workspaceId) {
      setStatus(null)
      return
    }
    const generation = ++generationRef.current
    setIsLoading(true)
    setError(null)
    try {
      const result = await api.gitStatus(workspaceId)
      if (generationRef.current !== generation) return
      setStatus(result)
    } catch (err) {
      if (generationRef.current !== generation) return
      setError(err instanceof Error ? err.message : 'Failed to fetch git status')
    } finally {
      if (generationRef.current === generation) setIsLoading(false)
    }
  }, [api, workspaceId])

  // Single effect: initial fetch + debounced refresh
  useEffect(() => {
    if (!api || !workspaceId) {
      setStatus(null)
      initialFetchDone.current = false
      lastWorkspaceRef.current = null
      return
    }

    // A workspace switch is not a refresh: debouncing it leaves the previous
    // project's files on screen, and they are clickable while they are there.
    if (!initialFetchDone.current || lastWorkspaceRef.current !== workspaceId) {
      initialFetchDone.current = true
      lastWorkspaceRef.current = workspaceId
      setStatus(null)
      setError(null)
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
