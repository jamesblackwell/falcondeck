import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  launchImageLibraryAsync,
  requestMediaLibraryPermissionsAsync,
} from 'expo-image-picker'

import {
  imagePickerAssetsToImageInputs,
  pickImageInputsFromLibrary,
} from './imageInputs'

describe('imageInputs', () => {
  beforeEach(() => {
    vi.mocked(requestMediaLibraryPermissionsAsync).mockReset()
    vi.mocked(launchImageLibraryAsync).mockReset()

    vi.mocked(requestMediaLibraryPermissionsAsync).mockResolvedValue({
      granted: true,
      accessPrivileges: 'all',
    } as any)
    vi.mocked(launchImageLibraryAsync).mockResolvedValue({
      canceled: true,
      assets: null,
    } as any)
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
        local_path: 'file:///tmp/diagram.png',
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
        local_path: 'file:///tmp/whiteboard.jpg',
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
})
