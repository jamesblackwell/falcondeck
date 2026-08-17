import { StyleSheet } from 'react-native-unistyles'

import { buildTheme, readAppearance } from './appearance'

const appearance = readAppearance()

const darkTheme = buildTheme('dark', appearance.fontScale, appearance.darkColorTheme)
const lightTheme = buildTheme('light', appearance.fontScale, appearance.lightColorTheme)

type AppThemes = {
  light: typeof lightTheme
  dark: typeof darkTheme
}

declare module 'react-native-unistyles' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesThemes extends AppThemes {}
}

StyleSheet.configure({
  themes: {
    light: lightTheme,
    dark: darkTheme,
  },
  settings:
    appearance.themeMode === 'system'
      ? { adaptiveThemes: true }
      : { initialTheme: appearance.themeMode },
})
