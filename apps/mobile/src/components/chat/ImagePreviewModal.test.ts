import { describe, expect, it } from 'vitest'

import { imagePreviewLayout } from './ImagePreviewModal'

describe('imagePreviewLayout', () => {
  it('keeps the labelled close row inside a short landscape viewport', () => {
    const layout = imagePreviewLayout(874, 402, 16, 44)

    expect(layout.cardMaxHeight).toBe(333)
    expect(layout.mediaHeight).toBe(289)
    expect(layout.mediaHeight + 44).toBeLessThanOrEqual(layout.cardMaxHeight)
  })

  it('preserves a square preview when portrait space allows it', () => {
    expect(imagePreviewLayout(402, 874, 16, 44).mediaHeight).toBe(370)
  })
})
