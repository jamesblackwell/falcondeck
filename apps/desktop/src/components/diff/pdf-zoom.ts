/** Horizontal breathing room around a page when fitting to the viewer width. */
const PDF_VIEW_PADDING = 32

export const MIN_PDF_ZOOM = 0.25
export const MAX_PDF_ZOOM = 6
const PDF_ZOOM_STEP = 1.25

export function clampPdfZoom(value: number) {
  return Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, value))
}

export function steppedPdfZoom(current: number, direction: 1 | -1) {
  return clampPdfZoom(direction > 0 ? current * PDF_ZOOM_STEP : current / PDF_ZOOM_STEP)
}

export function computePdfFitZoom(
  containerWidth: number,
  pageWidth: number,
  padding = PDF_VIEW_PADDING,
) {
  if (pageWidth <= 0 || containerWidth <= 0) return 1
  return clampPdfZoom((containerWidth - padding) / pageWidth)
}

export function formatPageCount(pages: number) {
  return `${pages} ${pages === 1 ? 'page' : 'pages'}`
}
