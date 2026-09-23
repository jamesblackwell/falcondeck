import { useEffect, useState } from 'react'

import { base64ToBytes } from '@falcondeck/client-core'

/** Same budget the daemon uses for previewable media. */
export const MAX_MEDIA_PREVIEW_BYTES = 16_000_000

export const MIN_IMAGE_ZOOM = 0.1
export const MAX_IMAGE_ZOOM = 8
export const IMAGE_ZOOM_STEP = 1.15
const IMAGE_VIEW_PADDING = 32

export type FileMediaKind = 'image' | 'video' | 'audio' | 'pdf'

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

const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
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
  if (extension in DOCUMENT_MIME_BY_EXT) return 'pdf'
  return null
}

export function mimeTypeFromPath(path: string) {
  const extension = extensionOf(path)
  return (
    IMAGE_MIME_BY_EXT[extension] ??
    VIDEO_MIME_BY_EXT[extension] ??
    AUDIO_MIME_BY_EXT[extension] ??
    DOCUMENT_MIME_BY_EXT[extension] ??
    null
  )
}

export function mediaKindFromMime(mime: string | null | undefined): FileMediaKind | null {
  if (!mime) return null
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
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
