import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
  requestMediaLibraryPermissionsAsync,
} from 'expo-image-picker'
import { MAX_IMAGE_ATTACHMENT_BYTES } from '@falcondeck/client-core'
import * as Clipboard from 'expo-clipboard'

import {
  imagePickerAssetsToImageInputs,
  pasteImageInputFromClipboard,
  pickImageInputFromCamera,
  pickImageInputsFromLibrary,
} from './imageInputs'

describe('imageInputs', () => {
  beforeEach(() => {
    vi.mocked(requestMediaLibraryPermissionsAsync).mockReset()
    vi.mocked(launchImageLibraryAsync).mockReset()
    vi.mocked(requestCameraPermissionsAsync).mockReset()
    vi.mocked(launchCameraAsync).mockReset()
    vi.mocked(Clipboard.getImageAsync).mockReset()
    vi.mocked(Clipboard.getImageAsync).mockResolvedValue(null)

    vi.mocked(requestMediaLibraryPermissionsAsync).mockResolvedValue({
      granted: true,
      accessPrivileges: 'all',
    } as any)
    vi.mocked(launchImageLibraryAsync).mockResolvedValue({
      canceled: true,
      assets: null,
    } as any)
    vi.mocked(requestCameraPermissionsAsync).mockResolvedValue({ granted: true } as any)
    vi.mocked(launchCameraAsync).mockResolvedValue({ canceled: true, assets: null } as any)
  })

  it('converts picker assets into image inputs', () => {
    expect(
      imagePickerAssetsToImageInputs([
        {
          uri: 'file:///tmp/diagram.png',
          fileName: 'diagram.png',
          mimeType: 'image/png',
          base64: 'abc123',
        } as any,
        {
          uri: 'file:///tmp/missing-base64.png',
          fileName: 'missing-base64.png',
          mimeType: 'image/png',
        } as any,
      ]),
    ).toEqual([
      expect.objectContaining({
        type: 'image',
        name: 'diagram.png',
        mime_type: 'image/png',
        url: 'data:image/png;base64,abc123',
        local_path: null,
      }),
    ])
  })

  it('falls back to the picker URI filename when the asset has no name', () => {
    expect(
      imagePickerAssetsToImageInputs([
        {
          uri: 'file:///var/mobile/Caches/ImagePicker/52CD892F.jpg',
          fileName: null,
          mimeType: 'image/jpeg',
          base64: 'abc123',
        } as any,
      ]),
    ).toEqual([
      expect.objectContaining({
        name: '52CD892F.jpg',
        local_path: null,
      }),
    ])
  })

  it('infers a safe image MIME type when the picker returns a blank value', () => {
    expect(
      imagePickerAssetsToImageInputs([
        {
          uri: 'file:///tmp/diagram.png',
          fileName: 'diagram.png',
          mimeType: '',
          base64: 'abc123',
        } as any,
      ]),
    ).toEqual([
      expect.objectContaining({
        mime_type: 'image/png',
        url: 'data:image/png;base64,abc123',
      }),
    ])
  })

  it('throws when photo permissions are denied', async () => {
    vi.mocked(requestMediaLibraryPermissionsAsync).mockResolvedValue({
      granted: false,
      accessPrivileges: 'none',
    } as any)

    await expect(pickImageInputsFromLibrary()).rejects.toThrow(
      'Photo library access is required to attach images.',
    )
  })

  it('throws when selected images cannot be read', async () => {
    vi.mocked(launchImageLibraryAsync).mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/unreadable.png',
          fileName: 'unreadable.png',
          mimeType: 'image/png',
        },
      ],
    } as any)

    await expect(pickImageInputsFromLibrary()).rejects.toThrow(
      'FalconDeck could not read the selected images.',
    )
  })

  it('returns selected image attachments', async () => {
    vi.mocked(launchImageLibraryAsync).mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/whiteboard.jpg',
          fileName: 'whiteboard.jpg',
          mimeType: 'image/jpeg',
          base64: 'encoded',
        },
      ],
    } as any)

    await expect(pickImageInputsFromLibrary()).resolves.toEqual([
      expect.objectContaining({
        type: 'image',
        name: 'whiteboard.jpg',
        mime_type: 'image/jpeg',
        url: 'data:image/jpeg;base64,encoded',
        local_path: null,
      }),
    ])

    expect(launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 0,
      orderedSelection: true,
      base64: true,
      quality: 0.8,
    })
  })

  it('returns a photo captured with the camera', async () => {
    vi.mocked(launchCameraAsync).mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/camera.jpg',
          fileName: 'camera.jpg',
          mimeType: 'image/jpeg',
          base64: 'camera-encoded',
        },
      ],
    } as any)

    await expect(pickImageInputFromCamera()).resolves.toEqual([
      expect.objectContaining({
        name: 'camera.jpg',
        url: 'data:image/jpeg;base64,camera-encoded',
      }),
    ])
    expect(launchCameraAsync).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      base64: true,
      quality: 0.8,
    })
  })

  it('returns an image copied to the clipboard', async () => {
    vi.mocked(Clipboard.getImageAsync).mockResolvedValue({
      data: 'data:image/png;base64,abc123==',
      size: { width: 1200, height: 800 },
    })

    await expect(pasteImageInputFromClipboard()).resolves.toEqual([
      expect.objectContaining({
        type: 'image',
        name: 'Pasted image.png',
        mime_type: 'image/png',
        url: 'data:image/png;base64,abc123==',
        local_path: null,
      }),
    ])
  })

  it('explains when the clipboard has no image', async () => {
    await expect(pasteImageInputFromClipboard()).rejects.toThrow(
      'No image found on the clipboard.',
    )
  })

  it('rejects malformed clipboard image data', async () => {
    vi.mocked(Clipboard.getImageAsync).mockResolvedValue({
      data: 'https://example.com/not-an-image.png',
      size: { width: 1200, height: 800 },
    })

    await expect(pasteImageInputFromClipboard()).rejects.toThrow(
      'FalconDeck could not read the clipboard image.',
    )
  })

  it('rejects an oversized clipboard image before it reaches composer state', async () => {
    const encodedLength = Math.ceil((MAX_IMAGE_ATTACHMENT_BYTES + 1) / 3) * 4
    vi.mocked(Clipboard.getImageAsync).mockResolvedValue({
      data: `data:image/png;base64,${'A'.repeat(encodedLength)}`,
      size: { width: 4000, height: 4000 },
    })

    await expect(pasteImageInputFromClipboard()).rejects.toThrow(
      'Pasted image.png is too large.',
    )
  })
})
