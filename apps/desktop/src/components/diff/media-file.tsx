import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Minus, Plus } from 'lucide-react'

import { base64ToBytes, formatArtifactSize } from '@falcondeck/client-core'

/** Same budget the daemon uses for previewable media. */
export const MAX_MEDIA_PREVIEW_BYTES = 16_000_000

export const MIN_IMAGE_ZOOM = 0.1
export const MAX_IMAGE_ZOOM = 8
export const IMAGE_ZOOM_STEP = 1.15
const IMAGE_VIEW_PADDING = 32

export type FileMediaKind = 'image' | 'video' | 'audio'

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
}

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
}

export function extensionOf(path: string) {
  const base = path.split('/').pop()?.toLowerCase() ?? ''
  const index = base.lastIndexOf('.')
  if (index <= 0) return ''
  return base.slice(index + 1)
}

export function mediaKindFromPath(path: string): FileMediaKind | null {
  const extension = extensionOf(path)
  if (extension in IMAGE_MIME_BY_EXT) return 'image'
  if (extension in VIDEO_MIME_BY_EXT) return 'video'
  if (extension in AUDIO_MIME_BY_EXT) return 'audio'
  return null
}

export function mimeTypeFromPath(path: string) {
  const extension = extensionOf(path)
  return (
    IMAGE_MIME_BY_EXT[extension] ??
    VIDEO_MIME_BY_EXT[extension] ??
    AUDIO_MIME_BY_EXT[extension] ??
    null
  )
}

export function mediaKindFromMime(mime: string | null | undefined): FileMediaKind | null {
  if (!mime) return null
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

export function isSvgFilePath(path: string) {
  return extensionOf(path) === 'svg'
}

export function shouldPreviewSvg(path: string, text: string | null | undefined) {
  return text != null && isSvgFilePath(path)
}

export function clampImageZoom(value: number) {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, value))
}

export function steppedImageZoom(current: number, direction: 1 | -1) {
  return clampImageZoom(direction > 0 ? current * IMAGE_ZOOM_STEP : current / IMAGE_ZOOM_STEP)
}

export function computeFitZoom(
  container: { width: number; height: number },
  image: { width: number; height: number },
  padding = IMAGE_VIEW_PADDING,
) {
  if (image.width <= 0 || image.height <= 0) return 1
  const availableWidth = Math.max(1, container.width - padding)
  const availableHeight = Math.max(1, container.height - padding)
  return clampImageZoom(
    Math.min(1, availableWidth / image.width, availableHeight / image.height),
  )
}

export function formatPixelSize(width: number, height: number) {
  if (width <= 0 || height <= 0) return null
  return `${Math.round(width).toLocaleString('en-US')} × ${Math.round(height).toLocaleString('en-US')}`
}

export function formatMediaDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** Builds a blob URL for workspace media and revokes it when the source changes. */
export function useMediaObjectUrl(
  contentBase64: string | null | undefined,
  mime: string | null | undefined,
  text: string | null | undefined = null,
) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!mime) {
      setUrl(null)
      return
    }
    let objectUrl: string | null = null
    if (contentBase64) {
      objectUrl = URL.createObjectURL(
        new Blob([base64ToBytes(contentBase64) as BlobPart], { type: mime }),
      )
    } else if (text != null) {
      objectUrl = URL.createObjectURL(new Blob([text], { type: mime }))
    }
    setUrl(objectUrl)
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [contentBase64, mime, text])
  return url
}

function MediaStatus({
  facts,
  zoom,
  isFit,
  onZoomIn,
  onZoomOut,
  onToggleFit,
}: {
  facts: Array<string | null | undefined>
  zoom?: number | null
  isFit?: boolean
  onZoomIn?: () => void
  onZoomOut?: () => void
  onToggleFit?: () => void
}) {
  const items = facts.filter((fact): fact is string => Boolean(fact))
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border-subtle px-3">
      <p className="fd-type-meta min-w-0 flex-1 truncate tabular-nums text-fg-muted">
        {items.join(' · ')}
      </p>
      {onZoomIn && onZoomOut && onToggleFit ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onZoomOut}
            aria-label="Zoom out"
            className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
          >
            <Minus aria-hidden="true" className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onToggleFit}
            aria-label={isFit ? 'Zoom to actual size' : 'Fit to view'}
            className="fd-focus min-w-10 rounded-[var(--fd-radius-sm)] px-1 py-0.5 text-center fd-type-meta tabular-nums text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
          >
            {zoom != null ? `${Math.round(zoom * 100)}%` : '—'}
          </button>
          <button
            type="button"
            onClick={onZoomIn}
            aria-label="Zoom in"
            className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
          >
            <Plus aria-hidden="true" className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ImageFilePreview({
  src,
  fileName,
  sizeBytes,
}: {
  src: string
  fileName: string
  sizeBytes?: number | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const panRef = useRef({ x: 0, y: 0 })
  const scaleRef = useRef(1)
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(
    null,
  )
  const [zoom, setZoom] = useState<number | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    setFailed(false)
    setNatural(null)
    setZoom(null)
    setPan({ x: 0, y: 0 })
    panRef.current = { x: 0, y: 0 }
  }, [src])

  useEffect(() => {
    panRef.current = pan
  }, [pan])

  useEffect(() => {
    const node = containerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (!box) return
      setContainerSize({ width: box.width, height: box.height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const fitZoom =
    natural && containerSize ? computeFitZoom(containerSize, natural) : 1
  const scale = zoom ?? fitZoom
  scaleRef.current = scale
  const canPan = natural != null && scale > fitZoom + 0.02

  const applyZoom = (next: number, origin?: { x: number; y: number }) => {
    const clamped = clampImageZoom(next)
    if (origin) {
      const current = scaleRef.current
      const ratio = clamped / current
      const nextPan = {
        x: origin.x - (origin.x - panRef.current.x) * ratio,
        y: origin.y - (origin.y - panRef.current.y) * ratio,
      }
      panRef.current = nextPan
      setPan(nextPan)
    }
    setZoom(clamped)
  }

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = node.getBoundingClientRect()
      const origin = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      }
      const direction: 1 | -1 = event.deltaY < 0 ? 1 : -1
      applyZoom(steppedImageZoom(scaleRef.current, direction), origin)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [src])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canPan) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    }
    setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const next = {
      x: drag.panX + (event.clientX - drag.x),
      y: drag.panY + (event.clientY - drag.y),
    }
    panRef.current = next
    setPan(next)
  }

  const endDrag = () => {
    dragRef.current = null
    setDragging(false)
  }

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-[length:var(--fd-text-xs)] text-fg-secondary">This image cannot be displayed</p>
        <p className="fd-type-meta text-fg-muted">{fileName}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={containerRef}
        tabIndex={0}
        aria-label={`Preview of ${fileName}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setZoom(zoom == null ? 1 : null)}
        onKeyDown={(event) => {
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            applyZoom(steppedImageZoom(scale, 1))
          } else if (event.key === '-' || event.key === '_') {
            event.preventDefault()
            applyZoom(steppedImageZoom(scale, -1))
          } else if (event.key === '0') {
            event.preventDefault()
            setZoom(null)
            setPan({ x: 0, y: 0 })
          } else if (event.key === '1') {
            event.preventDefault()
            setZoom(1)
          }
        }}
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-surface-0 outline-none ${
          canPan ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
        }`}
      >
        <img
          src={src}
          alt={fileName}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setNatural({ width: image.naturalWidth, height: image.naturalHeight })
            }
          }}
          onError={() => setFailed(true)}
          style={
            natural
              ? {
                  width: natural.width * scale,
                  height: natural.height * scale,
                  transform: `translate(${pan.x}px, ${pan.y}px)`,
                }
              : undefined
          }
          className={
            natural
              ? 'block max-w-none select-none bg-[length:16px_16px] [background-image:repeating-conic-gradient(var(--fd-bg-2)_0%_25%,var(--fd-bg-3)_0%_50%)]'
              : 'max-h-full max-w-full object-contain bg-[length:16px_16px] [background-image:repeating-conic-gradient(var(--fd-bg-2)_0%_25%,var(--fd-bg-3)_0%_50%)]'
          }
        />
      </div>
      <MediaStatus
        facts={[
          natural ? formatPixelSize(natural.width, natural.height) : null,
          formatArtifactSize(sizeBytes),
        ]}
        zoom={scale}
        isFit={zoom == null}
        onZoomOut={() => applyZoom(steppedImageZoom(scale, -1))}
        onZoomIn={() => applyZoom(steppedImageZoom(scale, 1))}
        onToggleFit={() => {
          if (zoom == null) setZoom(1)
          else {
            setZoom(null)
            setPan({ x: 0, y: 0 })
          }
        }}
      />
    </div>
  )
}

export function MediaFilePreview({
  kind,
  src,
  fileName,
  sizeBytes = null,
}: {
  kind: FileMediaKind
  src: string
  fileName: string
  sizeBytes?: number | null
}) {
  const [failed, setFailed] = useState(false)
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  useEffect(() => {
    setFailed(false)
    setVideoSize(null)
    setDuration(null)
  }, [src])

  if (kind === 'image') {
    return <ImageFilePreview src={src} fileName={fileName} sizeBytes={sizeBytes} />
  }

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-[length:var(--fd-text-xs)] text-fg-secondary">
          This {kind} cannot be displayed
        </p>
        <p className="fd-type-meta text-fg-muted">{fileName}</p>
      </div>
    )
  }

  if (kind === 'video') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-surface-0 p-4">
          <video
            src={src}
            controls
            playsInline
            preload="metadata"
            onError={() => setFailed(true)}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget
              setDuration(video.duration)
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setVideoSize({ width: video.videoWidth, height: video.videoHeight })
              }
            }}
            aria-label={`Preview of ${fileName}`}
            className="max-h-full max-w-full rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1"
          />
        </div>
        <MediaStatus
          facts={[
            videoSize ? formatPixelSize(videoSize.width, videoSize.height) : null,
            duration != null ? formatMediaDuration(duration) : null,
            formatArtifactSize(sizeBytes),
          ]}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <audio
          src={src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          aria-label={`Preview of ${fileName}`}
          className="w-full max-w-md"
        />
      </div>
      <MediaStatus
        facts={[
          duration != null ? formatMediaDuration(duration) : null,
          formatArtifactSize(sizeBytes),
        ]}
      />
    </div>
  )
}
