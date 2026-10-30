import { useCallback, useEffect, useRef, useState } from 'react'

/** Refresh from task changes, coalescing streaming updates without polling. */
export function useThreadResource<T>(id: string, updatedAt: string, load: (id: string) => Promise<T>) {
  const [result, setResult] = useState<{ id: string; data?: T; error?: string } | null>(null)
  const [observedAt, setObservedAt] = useState(Date.now)
  const schedule = useRef<(() => void) | null>(null)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastRequest = 0
    let request = 0
    const refresh = () => {
      timer = null
      lastRequest = Date.now()
      setObservedAt(lastRequest)
      const current = ++request
      void load(id).then(
        (data) => { if (!disposed && current === request) setResult({ id, data }) },
        (error: unknown) => { if (!disposed && current === request) setResult({ id, error: error instanceof Error ? error.message : 'Could not load activity.' }) },
      )
    }
    schedule.current = () => {
      if (timer === null) timer = setTimeout(refresh, Math.max(0, 5000 - (Date.now() - lastRequest)))
    }
    schedule.current()
    return () => {
      disposed = true
      schedule.current = null
      if (timer !== null) clearTimeout(timer)
    }
  }, [id, load])
  useEffect(() => { schedule.current?.() }, [id, updatedAt])
  const refresh = useCallback(() => schedule.current?.(), [])
  return { ...(result?.id === id ? result : null), observedAt, refresh }
}
