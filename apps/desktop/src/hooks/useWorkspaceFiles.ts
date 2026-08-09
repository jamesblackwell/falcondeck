import { useCallback, useEffect, useRef, useState } from 'react'

import type { WorkspaceFilesResponse } from '@falcondeck/client-core'

type WorkspaceFilesApi = {
  workspaceFiles: (workspaceId: string, threadId?: string | null) => Promise<WorkspaceFilesResponse>
}

export function useWorkspaceFiles(
  api: WorkspaceFilesApi | null,
  workspaceId: string | null,
  threadId: string | null,
  enabled: boolean,
) {
  const [result, setResult] = useState<WorkspaceFilesResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!api || !workspaceId || !enabled) return
    const generation = ++generationRef.current
    setIsLoading(true)
    setError(null)
    try {
      const next = await api.workspaceFiles(workspaceId, threadId)
      if (generation === generationRef.current) setResult(next)
    } catch (error) {
      if (generation === generationRef.current) {
        setError(error instanceof Error ? error.message : 'Failed to list workspace files')
      }
    } finally {
      if (generation === generationRef.current) setIsLoading(false)
    }
  }, [api, enabled, threadId, workspaceId])

  useEffect(() => {
    if (!enabled || !api || !workspaceId) {
      generationRef.current += 1
      if (!workspaceId) setResult(null)
      return
    }
    setResult(null)
    void refresh()
  }, [api, enabled, refresh, workspaceId])

  return { result, isLoading, error, refresh }
}
