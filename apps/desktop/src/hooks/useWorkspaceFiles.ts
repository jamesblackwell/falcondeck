import { useCallback, useEffect, useRef, useState } from 'react'

import type { WorkspaceFilesResponse } from '@falcondeck/client-core'

type WorkspaceFilesApi = {
  workspaceFiles: (
    workspaceId: string,
    threadId?: string | null,
    search?: string | null,
  ) => Promise<WorkspaceFilesResponse>
}

/** Long enough to swallow a burst of typing, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 150

/**
 * Lists workspace files, delegating search to the daemon.
 *
 * The daemon caps its listing, so filtering the response would only ever search
 * the visible prefix of a large repository. Sending the query instead lets the
 * search run over the whole tree.
 */
export function useWorkspaceFiles(
  api: WorkspaceFilesApi | null,
  workspaceId: string | null,
  threadId: string | null,
  enabled: boolean,
  query = '',
) {
  const [result, setResult] = useState<WorkspaceFilesResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const search = query.trim()

  const load = useCallback(
    async (search: string) => {
      if (!api || !workspaceId || !enabled) return
      const generation = ++generationRef.current
      setIsLoading(true)
      setError(null)
      try {
        const next = await api.workspaceFiles(workspaceId, threadId, search || null)
        if (generation === generationRef.current) setResult(next)
      } catch (error) {
        if (generation === generationRef.current) {
          setError(error instanceof Error ? error.message : 'Failed to list workspace files')
        }
      } finally {
        if (generation === generationRef.current) setIsLoading(false)
      }
    },
    [api, enabled, threadId, workspaceId],
  )

  const refresh = useCallback(() => load(search), [load, search])

  // A different workspace makes the current listing meaningless; a different
  // query does not, so typing narrows rows already on screen instead of
  // blanking the panel between keystrokes.
  useEffect(() => {
    setResult(null)
  }, [workspaceId])

  useEffect(() => {
    if (enabled && api && workspaceId) return
    generationRef.current += 1
    if (!workspaceId) setResult(null)
  }, [api, enabled, workspaceId])

  useEffect(() => {
    if (!search) {
      void load('')
      return
    }
    const timer = setTimeout(() => {
      void load(search)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [load, search])

  return { result, isLoading, error, refresh }
}
