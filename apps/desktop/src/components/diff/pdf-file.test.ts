import { describe, expect, it } from 'vitest'

import {
  MAX_PDF_ZOOM,
  MIN_PDF_ZOOM,
  clampPdfZoom,
  computePdfFitZoom,
  formatPageCount,
  steppedPdfZoom,
} from './pdf-file'

describe('computePdfFitZoom', () => {
  it('fits a page to the viewer width minus padding', () => {
    expect(computePdfFitZoom(632, 600, 32)).toBeCloseTo(1)
    expect(computePdfFitZoom(332, 600, 32)).toBeCloseTo(0.5)
  })

  it('falls back to 1 before the container has been measured', () => {
    expect(computePdfFitZoom(0, 600)).toBe(1)
    expect(computePdfFitZoom(600, 0)).toBe(1)
  })

  it('stays inside the zoom bounds for extreme page sizes', () => {
    expect(computePdfFitZoom(10_000, 10, 0)).toBe(MAX_PDF_ZOOM)
    expect(computePdfFitZoom(40, 10_000, 0)).toBe(MIN_PDF_ZOOM)
  })
})

describe('steppedPdfZoom', () => {
  it('steps in both directions and clamps', () => {
    expect(steppedPdfZoom(1, 1)).toBeCloseTo(1.25)
    expect(steppedPdfZoom(1, -1)).toBeCloseTo(0.8)
    expect(steppedPdfZoom(MAX_PDF_ZOOM, 1)).toBe(MAX_PDF_ZOOM)
    expect(steppedPdfZoom(MIN_PDF_ZOOM, -1)).toBe(MIN_PDF_ZOOM)
  })
})

describe('clampPdfZoom', () => {
  it('keeps values within range', () => {
    expect(clampPdfZoom(2)).toBe(2)
    expect(clampPdfZoom(0)).toBe(MIN_PDF_ZOOM)
    expect(clampPdfZoom(99)).toBe(MAX_PDF_ZOOM)
  })
})

describe('formatPageCount', () => {
  it('pluralises', () => {
    expect(formatPageCount(1)).toBe('1 page')
    expect(formatPageCount(12)).toBe('12 pages')
  })
})
