import { StyleSheet } from 'react-native-unistyles'

import {
  colors,
  spacing,
  radius,
  fontSize,
  lineHeight,
  fontFamily,
  shadow,
  duration,
  iconSize,
} from './tokens'

const darkTheme = {
  colors,
  spacing,
  radius,
  fontSize,
  lineHeight,
  fontFamily,
  shadow,
  duration,
  iconSize,
} as const

type AppThemes = {
  dark: typeof darkTheme
}

declare module 'react-native-unistyles' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface UnistylesThemes extends AppThemes {}
}

StyleSheet.configure({
  themes: {
    dark: darkTheme,
  },
  settings: {
    initialTheme: 'dark',
  },
})
