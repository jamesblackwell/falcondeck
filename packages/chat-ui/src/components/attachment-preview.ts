import { imageInputLabel, isSafeMediaUrl, type ImageInput } from '@falcondeck/client-core'

export function canRenderAttachmentImage(url: string) {
  return isSafeMediaUrl(url.trim(), 'image')
}

export function attachmentLabel(attachment: ImageInput) {
  return imageInputLabel(attachment)
}
