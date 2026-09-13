import {
  fileNameExtension,
  imageInputLabel,
  isSafeMediaUrl,
  type ImageInput,
} from '@falcondeck/client-core'

export function canRenderAttachmentImage(url: string) {
  return isSafeMediaUrl(url.trim(), 'image')
}

export function attachmentLabel(attachment: ImageInput) {
  return imageInputLabel(attachment)
}

export { isDocumentAttachment } from '@falcondeck/client-core'

/** Secondary line on a non-image chip: the file type, or a neutral fallback. */
export function attachmentTypeLabel(attachment: ImageInput) {
  const extension = fileNameExtension(
    attachment.name?.trim() || attachment.local_path?.trim() || '',
  )
  if (extension) return extension.toUpperCase()
  const mime = attachment.mime_type?.trim()
  if (mime) return mime.split('/').pop()?.toUpperCase() ?? 'File'
  return 'File'
}
