import * as ImagePicker from 'expo-image-picker'

import type { ImageInput } from '@falcondeck/client-core'

function imageInputId(index: number) {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${index}`
}

export function imagePickerAssetsToImageInputs(
  assets: ImagePicker.ImagePickerAsset[],
): ImageInput[] {
  return assets.flatMap((asset, index) => {
    if (!asset.base64) return []

    const mimeType = asset.mimeType ?? 'image/jpeg'

    return [{
      type: 'image',
      id: imageInputId(index),
      name: asset.fileName ?? null,
      mime_type: mimeType,
      url: `data:${mimeType};base64,${asset.base64}`,
      local_path: asset.uri,
    }]
  })
}

export async function pickImageInputsFromLibrary() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted && permission.accessPrivileges !== 'limited') {
    throw new Error('Photo library access is required to attach images.')
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 0,
    orderedSelection: true,
    base64: true,
    quality: 0.8,
  })

  if (result.canceled) {
    return []
  }

  const attachments = imagePickerAssetsToImageInputs(result.assets)
  if (result.assets.length > 0 && attachments.length === 0) {
    throw new Error('FalconDeck could not read the selected images.')
  }

  return attachments
}
