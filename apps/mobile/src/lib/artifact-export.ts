import { Directory, File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'

import {
  safeArtifactFilename,
  safeArtifactMimeType,
} from '@falcondeck/client-core'

export { safeArtifactFilename } from '@falcondeck/client-core'

const MAX_SHARE_BYTES = 50 * 1_000_000

export type EmbeddedArtifact = {
  filename: string
  mimeType: string | null
  text: string | null
  dataUrl: string | null
  byteSize: number | null
}

export function base64Payload(dataUrl: string): string | null {
  const match = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(
    dataUrl.trim(),
  )
  return match ? match[1] : null
}

function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

function decodedBase64ByteLength(payload: string): number {
  if (!payload) return 0
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

export function artifactShareByteSize(artifact: EmbeddedArtifact): number {
  const declared = Math.max(0, artifact.byteSize ?? 0)
  if (artifact.text != null) return Math.max(declared, utf8ByteLength(artifact.text))
  const payload = artifact.dataUrl ? base64Payload(artifact.dataUrl) : null
  return Math.max(declared, payload ? decodedBase64ByteLength(payload) : 0)
}

export function assertArtifactShareSize(
  artifact: EmbeddedArtifact,
  maxBytes = MAX_SHARE_BYTES,
): void {
  if (artifactShareByteSize(artifact) > maxBytes) {
    throw new Error('This artifact is too large to prepare on this device.')
  }
}

export async function shareEmbeddedArtifact(artifact: EmbeddedArtifact): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is unavailable on this device.')
  }
  assertArtifactShareSize(artifact)

  const filename = safeArtifactFilename(artifact.filename)
  const directory = new Directory(
    Paths.cache,
    `falcondeck-share-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  )
  try {
    directory.create()
    const file = new File(directory, filename)
    file.create({ overwrite: true })
    if (artifact.text != null) {
      file.write(artifact.text)
    } else {
      const payload = artifact.dataUrl ? base64Payload(artifact.dataUrl) : null
      if (!payload) throw new Error('The provider did not supply exportable artifact content.')
      file.write(payload, { encoding: 'base64' })
    }
    await Sharing.shareAsync(file.uri, {
      dialogTitle: `Share ${filename}`,
      mimeType: safeArtifactMimeType(artifact.mimeType) ?? undefined,
    })
  } finally {
    if (directory.exists) directory.delete()
  }
}
