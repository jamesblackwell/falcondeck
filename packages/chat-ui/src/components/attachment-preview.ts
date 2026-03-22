import type { ImageInput } from '@falcondeck/client-core'

export function canRenderAttachmentImage(url: string) {
  const normalized = url.trim()
  return (
    normalized.startsWith('data:') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('blob:') ||
    normalized.startsWith('asset:')
  )
}

export function attachmentLabel(attachment: ImageInput) {
  if (attachment.name && attachment.name.trim().length > 0) {
    return attachment.name.trim()
  }

  const candidate = (attachment.local_path ?? attachment.url).trim()
  const segments = candidate.split(/[\\/]/).map((segment) => segment.trim()).filter(Boolean)
  return segments.at(-1) ?? 'attachment'
}
