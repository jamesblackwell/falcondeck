import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  WorkspaceFileResponse,
  WriteWorkspaceFilePayload,
} from '@falcondeck/client-core'

type WorkspaceFileApi = {
  workspaceFile: (
    workspaceId: string,
    path: string,
    threadId?: string | null,
  ) => Promise<WorkspaceFileResponse>
  writeWorkspaceFile: (
    workspaceId: string,
    path: string,
    payload: WriteWorkspaceFilePayload,
    threadId?: string | null,
  ) => Promise<WorkspaceFileResponse>
}

export function useWorkspaceFile(
  api: WorkspaceFileApi | null,
  workspaceId: string | null,
  threadId: string | null,
  filePath: string | null,
) {
  const [file, setFile] = useState<WorkspaceFileResponse | null>(null)
  const [isLoading, setIsLoading] = useState(() => Boolean(api && workspaceId && filePath))
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    if (!api || !workspaceId || !filePath) {
      setFile(null)
      setError(null)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const next = await api.workspaceFile(workspaceId, filePath, threadId)
      if (requestId !== requestIdRef.current) return
      setFile(next)
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      setError(error instanceof Error ? error.message : 'Failed to read workspace file')
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false)
    }
  }, [api, filePath, threadId, workspaceId])

  useEffect(() => {
    setFile(null)
    void load()
    return () => {
      requestIdRef.current += 1
    }
  }, [load])

  const save = useCallback(
    async (content: string) => {
      if (!api || !workspaceId || !filePath || !file) return false
      setIsSaving(true)
      setError(null)
      try {
        const next = await api.writeWorkspaceFile(
          workspaceId,
          filePath,
          { content, expected_version: file.version },
          threadId,
        )
        setFile(next)
        return true
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to save workspace file')
        return false
      } finally {
        setIsSaving(false)
      }
    },
    [api, file, filePath, threadId, workspaceId],
  )

  return { file, isLoading, isSaving, error, reload: load, save }
}
