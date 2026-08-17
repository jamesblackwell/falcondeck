import { useCallback, useEffect, useRef, useState } from 'react'

export type VirtualRows = {
  containerRef: (node: HTMLDivElement | null) => void
  onScroll: () => void
  start: number
  end: number
  offsetY: number
  totalHeight: number
}

export function useVirtualRows(rowCount: number, rowHeight: number, overscan = 6): VirtualRows {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const containerCallbackRef = useCallback((next: HTMLDivElement | null) => {
    containerRef.current = next
    setNode(next)
  }, [])

  const onScroll = useCallback(() => {
    const el = containerRef.current
    if (el) setScrollTop(el.scrollTop)
  }, [])

  useEffect(() => {
    if (!node) return
    setViewportHeight(node.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setViewportHeight(node.clientHeight)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  const measured = viewportHeight > 0
  const maxStart = Math.max(0, rowCount - 1)
  const start = measured
    ? Math.min(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan), maxStart)
    : 0
  const count = measured ? Math.ceil(viewportHeight / rowHeight) + overscan * 2 : rowCount
  const end = Math.min(rowCount, start + count)

  return {
    containerRef: containerCallbackRef,
    onScroll,
    start,
    end,
    offsetY: start * rowHeight,
    totalHeight: rowCount * rowHeight,
  }
}
