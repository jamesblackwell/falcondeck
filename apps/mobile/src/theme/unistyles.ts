import { StyleSheet } from 'react-native-unistyles'

import { applyNativeColorScheme, buildTheme, readAppearance } from './appearance'

const appearance = readAppearance()

// Before first render, so the launch header and status bar already match the
// saved mode rather than flashing the phone's system appearance.
applyNativeColorScheme(appearance.themeMode)

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
