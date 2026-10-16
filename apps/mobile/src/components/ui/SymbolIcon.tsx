import { memo, type ComponentType } from 'react'
import { Platform, type StyleProp, type ViewStyle } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'
import type { SymbolViewProps } from 'expo-symbols'

type LucideLikeIcon = ComponentType<{
  size?: number
  color?: string
  strokeWidth?: number
  fill?: string
}>

type SymbolWeight = 'light' | 'regular' | 'medium' | 'semibold' | 'bold'

// The SF Symbols view ships with expo-router, but a JS-only update can still
// reach a binary without it; check the registry before using the view.
function loadSymbolView(): ComponentType<SymbolViewProps> | null {
  if (Platform.OS !== 'ios') return null
  try {
    if (requireOptionalNativeModule('SymbolModule') === null) return null
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('expo-symbols').SymbolView as ComponentType<SymbolViewProps>) ?? null
  } catch {
    return null
  }
}

const SymbolView = loadSymbolView()

/** True where chrome icons render as native SF Symbols. */
export const hasNativeSymbols = SymbolView !== null

const LUCIDE_STROKE: Record<SymbolWeight, number> = {
  light: 1.5,
  regular: 1.75,
  medium: 2,
  semibold: 2.25,
  bold: 2.5,
}

interface SymbolIconProps {
  /** SF Symbol name, e.g. `square.and.pencil`. */
  name: SymbolViewProps['name']
  /** The lucide icon drawn where SF Symbols are unavailable. */
  fallback: LucideLikeIcon
  size: number
  color: string
  weight?: SymbolWeight
  /** Fills the lucide fallback, for symbols whose SF form is `.fill`. */
  filled?: boolean
  style?: StyleProp<ViewStyle>
}

/**
 * A chrome icon: the native SF Symbol on iOS — so glass controls carry the
 * same glyphs, weights and optical sizing as UIKit's own bars — and the
 * matching lucide icon everywhere else.
 */
export const SymbolIcon = memo(function SymbolIcon({
  name,
  fallback: Fallback,
  size,
  color,
  weight = 'regular',
  filled = false,
  style,
}: SymbolIconProps) {
  const fallback = (
    <Fallback
      size={size}
      color={color}
      strokeWidth={LUCIDE_STROKE[weight]}
      fill={filled ? color : undefined}
    />
  )
  if (!SymbolView) return fallback
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      weight={weight}
      type="monochrome"
      resizeMode="scaleAspectFit"
      fallback={fallback}
      style={style}
    />
  )
})
