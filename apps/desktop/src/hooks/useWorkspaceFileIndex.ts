import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { WorkspaceFilesResponse } from '@falcondeck/client-core'
import type { WorkspaceFileResolver } from '@falcondeck/chat-ui'

type WorkspaceFilesApi = {
  workspaceFiles: (workspaceId: string, threadId?: string | null) => Promise<WorkspaceFilesResponse>
}

type FileIndex = {
  files: Set<string>
  truncated: boolean
}

/**
 * Lazily answers "does this relative path exist in the workspace?" for the
 * transcript, so agent prose like `src/app.ts` becomes a link only when it
 * names a real file. The listing is fetched once on first use per
 * workspace/thread and refreshed whenever git activity bumps the trigger;
 * until a refresh lands, answers keep coming from the previous listing.
 */
export function useWorkspaceFileIndex(
  api: WorkspaceFilesApi | null,
  workspaceId: string | null,
  threadId: string | null,
  refreshTrigger: number,
): { resolve: WorkspaceFileResolver | null; version: number } {
  const indexRef = useRef<FileIndex | null>(null)
  const pendingRef = useRef<Promise<FileIndex | null> | null>(null)
  const scopeRef = useRef<string | null>(null)
  const [version, setVersion] = useState(0)
  const scope = api && workspaceId ? `${workspaceId}:${threadId ?? ''}` : null

  const load = useCallback((): Promise<FileIndex | null> => {
    if (!api || !workspaceId) return Promise.resolve(null)
    if (pendingRef.current) return pendingRef.current
    const requestScope = scope
    const request = api
      .workspaceFiles(workspaceId, threadId)
      .then((response): FileIndex | null => {
        if (scopeRef.current !== requestScope) return null
        const index = { files: new Set(response.files), truncated: response.truncated }
        indexRef.current = index
        setVersion((current) => current + 1)
        return index
      })
      .catch(() => indexRef.current)
      .finally(() => {
        if (pendingRef.current === request) pendingRef.current = null
      })
    pendingRef.current = request
    return request
  }, [api, scope, threadId, workspaceId])

  // A new workspace or thread invalidates everything; a git refresh only
  // schedules a reload when someone has asked about this scope before.
  useEffect(() => {
    if (scopeRef.current !== scope) {
      scopeRef.current = scope
      indexRef.current = null
      pendingRef.current = null
      setVersion((current) => current + 1)
      return
    }
    if (indexRef.current) {
      pendingRef.current = null
      void load()
    }
  }, [load, refreshTrigger, scope])

  const resolve = useCallback<WorkspaceFileResolver>(
    (filePath) => {
      const lookup = (index: FileIndex | null): boolean | null => {
        if (!index) return null
        if (index.files.has(filePath)) return true
        return index.truncated ? null : false
      }
      if (indexRef.current) return lookup(indexRef.current)
      return load().then(lookup)
    },
    [load],
  )

  return useMemo(
    () => ({ resolve: scope ? resolve : null, version }),
    [resolve, scope, version],
  )
}
