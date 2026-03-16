import { useEffect, useState } from 'react'

import type { GitDiffResponse } from '@falcondeck/client-core'

type DaemonApi = {
  gitDiff: (workspaceId: string, path?: string) => Promise<GitDiffResponse>
}

export function useGitDiff(
  api: DaemonApi | null,
  workspaceId: string | null,
  filePath: string | null,
) {
  const [diff, setDiff] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api || !workspaceId || !filePath) {
      setDiff(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError(null)

    void api
      .gitDiff(workspaceId, filePath)
      .then((result) => {
        if (!cancelled) setDiff(result.diff)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to fetch diff')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [api, workspaceId, filePath])

  return { diff, isLoading, error }
}
