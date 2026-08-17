import { memo } from 'react'
import Svg, { Path } from 'react-native-svg'
import { Terminal } from 'lucide-react-native'

import { providerMark } from '@falcondeck/client-core'

type ProviderIconProps = {
  provider: string
  size?: number
  color: string
}

/** Official vendor mark for a coding harness. Unknown ids use a terminal. */
export const ProviderIcon = memo(function ProviderIcon({
  provider,
  size = 14,
  color,
}: ProviderIconProps) {
  const mark = providerMark(provider)
  if (!mark) {
    return <Terminal size={size} color={color} />
  }

  return (
    <Svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      fill={color}
      fillRule={mark.fillRule}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {mark.paths.map((path) => (
        <Path
          key={path.d}
          d={path.d}
          fill={color}
          fillOpacity={path.opacity}
        />
      ))}
    </Svg>
  )
})
