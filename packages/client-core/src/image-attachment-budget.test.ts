import { describe, expect, it } from 'vitest'

import {
  filesToImageInputs,
  imageInputByteSize,
  MAX_IMAGE_ATTACHMENT_BYTES,
  validateImageAttachmentBudget,
} from './snapshot'
import type { ImageInput } from './types'

function image(name: string, bytes: number): ImageInput {
  const encodedLength = Math.ceil(bytes / 3) * 4
  return {
    type: 'image',
    id: name,
    name,
    mime_type: 'image/png',
    url: `data:image/png;base64,${'A'.repeat(encodedLength)}`,
    local_path: null,
  }
}

describe('image attachment budgets', () => {
  it('measures base64 data URLs without decoding another byte buffer', () => {
    expect(imageInputByteSize(image('small.png', 12))).toBe(12)
  })

  it('rejects one oversized image with its filename', () => {
    expect(() =>
      validateImageAttachmentBudget([
        image('panorama.png', MAX_IMAGE_ATTACHMENT_BYTES + 1),
      ]),
    ).toThrow('panorama.png is too large. Images must be 3.5 MB or smaller.')
  })

  it('rejects an oversized browser file before FileReader allocates it', async () => {
    const files = [
      {
        name: 'raw-photo.png',
        type: 'image/png',
        size: MAX_IMAGE_ATTACHMENT_BYTES + 1,
      },
    ] as unknown as FileList

    await expect(filesToImageInputs(files)).rejects.toThrow(
      'raw-photo.png is too large. Images must be 3.5 MB or smaller.',
    )
  })

  it('rejects an oversized aggregate before relay encryption', () => {
    expect(() =>
      validateImageAttachmentBudget([
        image('one.png', 3_000_000),
        image('two.png', 3_000_000),
        image('three.png', 3_000_000),
        image('four.png', 2_000_000),
      ]),
    ).toThrow(
      'Those images are too large together. Attach no more than 10 MB at once.',
    )
  })
})
