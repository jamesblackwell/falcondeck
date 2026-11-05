import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ConversationItem } from '@falcondeck/client-core'

type Tool = Extract<ConversationItem, { kind: 'tool_call' }>
export type ToolItemLoader = (itemId: string) => Promise<ConversationItem>
export const ToolItemLoaderContext = createContext<ToolItemLoader | undefined>(undefined)

let transfers = 0
const waiting: Array<() => void> = []
async function boundedLoad(loader: ToolItemLoader, id: string, active: () => boolean) {
  if (transfers >= 2) await new Promise<void>(resolve => waiting.push(resolve))
  else transfers += 1
  try { return active() ? await loader(id) : null }
  finally {
    const next = waiting.shift()
    if (next) next()
    else transfers -= 1
  }
}

/** Fetch on expansion and once more when the parent settles, never per child event. */
export function useToolItem(source: Tool, open: boolean) {
  const loader = useContext(ToolItemLoaderContext)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const sourceRef = useRef(source)
  sourceRef.current = source
  const [full, setFull] = useState<Tool | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'too_large'>('idle')
  const [attempt, setAttempt] = useState(0)
  const truncated = Boolean(source.display.output_total_bytes)
  const settled = source.completed_at != null || /^(completed|failed|interrupted|cancelled)$/.test(source.status)
  useEffect(() => {
    let active = true
    if (!open) { setFull(null); setStatus('idle'); return }
    if (!loaderRef.current || !sourceRef.current.display.output_total_bytes) { setFull(null); setStatus('idle'); return }
    setStatus('loading')
    void boundedLoad(loaderRef.current, source.id, () => active).then(item => {
      if (!active || !item || item.kind !== 'tool_call' || item.id !== source.id) return
      setFull(item); setStatus('ready')
    }).catch(error => {
      if (active) setStatus(String(error).includes('ITEM_TOO_LARGE') ? 'too_large' : 'error')
    })
    return () => { active = false }
  }, [source.id, open, settled, truncated, attempt])
  const item = full?.id === source.id ? { ...source, output: full.output, detail: full.detail, display: { ...source.display, output_total_bytes: full.display.output_total_bytes } } : source
  return { item, status, refresh: () => setAttempt(value => value + 1) }
}
