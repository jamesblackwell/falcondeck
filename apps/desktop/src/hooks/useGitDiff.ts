import { useEffect, useState } from 'react'

import type { GitDiffResponse, GitFileStatus } from '@falcondeck/client-core'

type DaemonApi = {
  gitDiff: (
    workspaceId: string,
    path?: string,
    status?: GitFileStatus | null,
    threadId?: string | null,
  ) => Promise<GitDiffResponse>
}

export function useGitDiff(
  api: DaemonApi | null,
  workspaceId: string | null,
  filePath: string | null,
  fileStatus: GitFileStatus | null,
  threadId: string | null = null,
) {
  const [diff, setDiff] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isActive = Boolean(api && workspaceId && filePath)

  useEffect(() => {
    if (!api || !workspaceId || !filePath) return

    let cancelled = false

    const loadDiff = async () => {
      setIsLoading(true)
      setDiff(null)
      setContent(null)
      setError(null)

      try {
        const result = await api.gitDiff(workspaceId, filePath, fileStatus, threadId)
        if (!cancelled) {
          setDiff(result.diff)
          setContent(result.content ?? null)
        }
      } catch (err) {
        if (!cancelled) {
          setDiff(null)
          setContent(null)
          setError(err instanceof Error ? err.message : 'Failed to fetch diff')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadDiff()

    return () => { cancelled = true }
  }, [api, workspaceId, filePath, fileStatus, threadId])

  return {
    diff: isActive ? diff : null,
    content: isActive ? content : null,
    isLoading: isActive ? isLoading : false,
    error: isActive ? error : null,
  }
}
