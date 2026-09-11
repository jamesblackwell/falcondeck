import { useWindowDimensions } from 'react-native'

/**
 * Width at which iOS hands an app the "regular" size class — every iPad in
 * full screen, and the widest Split View slots. Below it the phone layout is
 * still the right answer.
 */
export const TABLET_MIN_WIDTH = 768

/**
 * Width at which the sidebar stops being a modal drawer and simply stays on
 * screen next to the conversation. Landscape iPads clear it; portrait ones do
 * not, because a 360pt sidebar would leave the transcript narrower than a
 * phone's.
 */
export const PERMANENT_SIDEBAR_MIN_WIDTH = 1024

/** How wide the sidebar is whenever it is not the whole screen. */
export const SIDEBAR_WIDTH = 360

/**
 * Longest comfortable line of body text. Prose past roughly 90 characters
 * makes the eye lose its place on the return sweep, and an iPad in landscape
 * is over 130 characters wide at our body size.
 */
export const READING_MAX_WIDTH = 760

export interface TabletLayout {
  /** Regular size class: an iPad, or a wide Split View slot. */
  isTablet: boolean
  /** The sidebar is displayed alongside content rather than over it. */
  hasPermanentSidebar: boolean
  /** Width left for the conversation once the sidebar has taken its share. */
  contentWidth: number
  /**
   * Horizontal padding that centres a reading column inside the content pane.
   * Zero on phones, where the pane is already narrower than the column.
   */
  readingGutter: number
}

export function useTabletLayout(): TabletLayout {
  const { width } = useWindowDimensions()

  const isTablet = width >= TABLET_MIN_WIDTH
  const hasPermanentSidebar = width >= PERMANENT_SIDEBAR_MIN_WIDTH
  const contentWidth = hasPermanentSidebar ? width - SIDEBAR_WIDTH : width
  const readingGutter = Math.max(0, Math.floor((contentWidth - READING_MAX_WIDTH) / 2))

  return { isTablet, hasPermanentSidebar, contentWidth, readingGutter }
}
