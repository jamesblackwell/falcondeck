import { useCallback, useEffect, useRef, useState } from 'react'

import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'

import { ActivityDiamond } from '@falcondeck/ui'

/** Horizontal breathing room around a page when fitting to the viewer width. */
const PDF_VIEW_PADDING = 32
/** Pages this far outside the viewport are rendered ahead of the scroll. */
const PDF_RENDER_MARGIN = '600px'

export const MIN_PDF_ZOOM = 0.25
export const MAX_PDF_ZOOM = 6
const PDF_ZOOM_STEP = 1.25

export function clampPdfZoom(value: number) {
  return Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, value))
}

export function steppedPdfZoom(current: number, direction: 1 | -1) {
  return clampPdfZoom(direction > 0 ? current * PDF_ZOOM_STEP : current / PDF_ZOOM_STEP)
}

export function computePdfFitZoom(
  containerWidth: number,
  pageWidth: number,
  padding = PDF_VIEW_PADDING,
) {
  if (pageWidth <= 0 || containerWidth <= 0) return 1
  return clampPdfZoom((containerWidth - padding) / pageWidth)
}

export function formatPageCount(pages: number) {
  return `${pages} ${pages === 1 ? 'page' : 'pages'}`
}

/**
 * pdf.js and its worker are ~1 MB, so they stay in a lazy chunk that only
 * loads the first time somebody opens a PDF.
 */
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null
function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ])
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    return pdfjs
  })()
  return pdfjsPromise
}

type PdfDocumentState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; doc: PDFDocumentProxy; pageWidth: number; pageHeight: number }

/** Opens the document and reports page one's size so pages can reserve space. */
function usePdfDocument(bytes: Uint8Array | null) {
  const [state, setState] = useState<PdfDocumentState>({ status: 'loading' })
  useEffect(() => {
    if (!bytes) {
      setState({ status: 'loading' })
      return
    }
    let cancelled = false
    let task: PDFDocumentLoadingTask | null = null
    setState({ status: 'loading' })
    void (async () => {
      try {
        const pdfjs = await loadPdfjs()
        // getDocument detaches the buffer it is handed, so keep ours intact.
        task = pdfjs.getDocument({ data: bytes.slice() })
        const doc = await task.promise
        const viewport = (await doc.getPage(1)).getViewport({ scale: 1 })
        if (cancelled) return
        setState({
          status: 'ready',
          doc,
          pageWidth: viewport.width,
          pageHeight: viewport.height,
        })
      } catch {
        if (!cancelled) setState({ status: 'failed' })
      }
    })()
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [bytes])
  return state
}

function PdfPage({
  doc,
  pageNumber,
  scale,
  placeholder,
  onVisible,
}: {
  doc: PDFDocumentProxy
  pageNumber: number
  scale: number
  placeholder: { width: number; height: number }
  onVisible: (pageNumber: number, visible: boolean) => void
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  // Measured at a known scale so zoom can resize the box before the re-render lands.
  const [size, setSize] = useState<{ width: number; height: number; scale: number } | null>(null)

  useEffect(() => {
    const node = wrapperRef.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    // Two thresholds in one observer: anything near the viewport renders, and
    // whatever is actually on screen drives the page counter.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setNearViewport(true)
          onVisible(pageNumber, entry.intersectionRatio > 0.1)
        }
      },
      { root: node.closest('[data-pdf-scroll]'), rootMargin: PDF_RENDER_MARGIN, threshold: [0, 0.1] },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [onVisible, pageNumber])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !nearViewport) return
    let cancelled = false
    let task: { cancel: () => void } | null = null
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const ratio = Math.min(2, window.devicePixelRatio || 1)
        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        setSize({ width: viewport.width, height: viewport.height, scale })
        const render = page.render({
          canvas,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        })
        task = render
        await render.promise
      } catch {
        // A cancelled render (zoom change, unmount) is the common case here.
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, nearViewport, pageNumber, scale])

  const ratioToScale = size ? scale / size.scale : 1
  const width = size ? size.width * ratioToScale : placeholder.width * scale
  const height = size ? size.height * ratioToScale : placeholder.height * scale
  return (
    <div
      ref={wrapperRef}
      data-pdf-page={pageNumber}
      style={{ width, height }}
      className="shrink-0 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.25)]"
    >
      <canvas ref={canvasRef} style={{ width, height }} className="block" />
    </div>
  )
}

export function PdfFilePreview({
  bytes,
  fileName,
  footer,
}: {
  bytes: Uint8Array | null
  fileName: string
  /** Renders the status bar once page and zoom state are known. */
  footer: (state: {
    facts: Array<string | null>
    zoom: number
    isFit: boolean
    onZoomIn: () => void
    onZoomOut: () => void
    onToggleFit: () => void
  }) => React.ReactNode
}) {
  const state = usePdfDocument(bytes)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [zoom, setZoom] = useState<number | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const visiblePages = useRef(new Set<number>())

  useEffect(() => {
    const node = scrollRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) setContainerWidth(box.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [state.status])

  const onVisible = useCallback((pageNumber: number, visible: boolean) => {
    const pages = visiblePages.current
    if (visible) pages.add(pageNumber)
    else pages.delete(pageNumber)
    const first = pages.size > 0 ? Math.min(...pages) : null
    if (first != null) setCurrentPage(first)
  }, [])

  if (state.status === 'failed') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-[length:var(--fd-text-xs)] text-fg-secondary">
          This PDF cannot be displayed
        </p>
        <p className="fd-type-meta text-fg-muted">{fileName}</p>
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-surface-0">
        <ActivityDiamond size="lg" aria-label={`Loading ${fileName}`} />
      </div>
    )
  }

  const fitZoom = computePdfFitZoom(containerWidth, state.pageWidth)
  const scale = zoom ?? fitZoom
  const pageCount = state.doc.numPages

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        data-pdf-scroll=""
        tabIndex={0}
        aria-label={`Preview of ${fileName}`}
        onKeyDown={(event) => {
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            setZoom(steppedPdfZoom(scale, 1))
          } else if (event.key === '-' || event.key === '_') {
            event.preventDefault()
            setZoom(steppedPdfZoom(scale, -1))
          } else if (event.key === '0') {
            event.preventDefault()
            setZoom(null)
          }
        }}
        className="flex min-h-0 flex-1 flex-col items-center gap-4 overflow-auto bg-surface-0 p-4 outline-none"
      >
        {Array.from({ length: pageCount }, (_, index) => (
          <PdfPage
            key={index + 1}
            doc={state.doc}
            pageNumber={index + 1}
            scale={scale}
            placeholder={{ width: state.pageWidth, height: state.pageHeight }}
            onVisible={onVisible}
          />
        ))}
      </div>
      {footer({
        facts: [
          pageCount > 1 ? `Page ${Math.min(currentPage, pageCount)} of ${pageCount}` : formatPageCount(pageCount),
        ],
        zoom: scale,
        isFit: zoom == null,
        onZoomIn: () => setZoom(steppedPdfZoom(scale, 1)),
        onZoomOut: () => setZoom(steppedPdfZoom(scale, -1)),
        onToggleFit: () => setZoom(zoom == null ? 1 : null),
      })}
    </div>
  )
}
