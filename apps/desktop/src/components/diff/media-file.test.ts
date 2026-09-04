import { describe, expect, it } from 'vitest'

import {
  computeFitZoom,
  formatMediaDuration,
  formatPixelSize,
  isSvgFilePath,
  mediaKindFromMime,
  mediaKindFromPath,
  mimeTypeFromPath,
  shouldPreviewSvg,
  steppedImageZoom,
} from './media-file'

describe('mediaKindFromPath', () => {
  it('classifies images, video, and audio by extension', () => {
    expect(mediaKindFromPath('qa/shot.PNG')).toBe('image')
    expect(mediaKindFromPath('logo.svg')).toBe('image')
    expect(mediaKindFromPath('clips/demo.webm')).toBe('video')
    expect(mediaKindFromPath('voice.m4a')).toBe('audio')
    expect(mediaKindFromPath('src/App.tsx')).toBeNull()
  })
})

describe('mimeTypeFromPath', () => {
  it('returns a browser-usable MIME type', () => {
    expect(mimeTypeFromPath('shot.jpg')).toBe('image/jpeg')
    expect(mimeTypeFromPath('clip.mp4')).toBe('video/mp4')
    expect(mimeTypeFromPath('sound.wav')).toBe('audio/wav')
    expect(mimeTypeFromPath('notes.md')).toBeNull()
  })
})

describe('mediaKindFromMime', () => {
  it('reads the major type from a MIME string', () => {
    expect(mediaKindFromMime('image/png')).toBe('image')
    expect(mediaKindFromMime('video/webm')).toBe('video')
    expect(mediaKindFromMime('audio/mpeg')).toBe('audio')
    expect(mediaKindFromMime('application/octet-stream')).toBeNull()
  })
})

describe('shouldPreviewSvg', () => {
  it('previews SVG source as an image', () => {
    expect(isSvgFilePath('assets/logo.SVG')).toBe(true)
    expect(shouldPreviewSvg('assets/logo.svg', '<svg></svg>')).toBe(true)
    expect(shouldPreviewSvg('assets/logo.svg', null)).toBe(false)
    expect(shouldPreviewSvg('shot.png', '<svg></svg>')).toBe(false)
  })
})

describe('image zoom math', () => {
  it('fits an image inside the pane without upscaling', () => {
    expect(computeFitZoom({ width: 200, height: 200 }, { width: 400, height: 200 })).toBeCloseTo(0.42)
    expect(computeFitZoom({ width: 800, height: 800 }, { width: 100, height: 100 })).toBe(1)
  })

  it('steps zoom in and out', () => {
    expect(steppedImageZoom(1, 1)).toBeCloseTo(1.15)
    expect(steppedImageZoom(1.15, -1)).toBeCloseTo(1)
  })
})

describe('media captions', () => {
  it('formats pixel size and duration', () => {
    expect(formatPixelSize(1920, 1080)).toBe('1,920 × 1,080')
    expect(formatMediaDuration(12.4)).toBe('0:12')
    expect(formatMediaDuration(3723)).toBe('1:02:03')
    expect(formatMediaDuration(Number.NaN)).toBeNull()
  })
})
