// Stub unistyles for tests — provides minimal theme structure
// matching the tokens shape so StyleSheet.create(theme => ...) doesn't crash

const stubTheme = {
  colors: {
    surface: { 0: '#000', 1: '#111', 2: '#222', 3: '#333', 4: '#444' },
    fg: { primary: '#fff', secondary: '#ccc', tertiary: '#999', muted: '#666', faint: '#444' },
    border: { subtle: '#111', default: '#222', emphasis: '#333', strong: '#444' },
    accent: { default: '#0f0', muted: 'rgba(0,255,0,0.1)', strong: '#0f0', dim: 'rgba(0,255,0,0.05)' },
    success: { default: '#0f0', muted: 'rgba(0,255,0,0.1)' },
    warning: { default: '#ff0', muted: 'rgba(255,255,0,0.1)' },
    danger: { default: '#f00', muted: 'rgba(255,0,0,0.1)' },
    info: { default: '#00f', muted: 'rgba(0,0,255,0.1)' },
    diff: { added: '#0f01', removed: '#f001', addedText: '#0f0', removedText: '#f00' },
    transparent: 'transparent',
    white: '#fff',
    black: '#000',
  },
  spacing: { 0: 0, px: 1, 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64 },
  radius: { sm: 6, md: 8, lg: 12, xl: 16, '2xl': 20, full: 999 },
  fontSize: { '2xs': 10, xs: 12, sm: 14, base: 16, md: 17, lg: 19, xl: 22, '2xl': 26, '3xl': 32 },
  lineHeight: { tight: 1.25, normal: 1.5, relaxed: 1.65 },
  fontFamily: { sans: 'System', mono: 'Courier' },
  shadow: { sm: {}, md: {}, lg: {} },
  duration: { fast: 100, normal: 150, slow: 250 },
  iconSize: { sm: 16, md: 20, lg: 24, xl: 32 },
}

export const StyleSheet = {
  create: (factory: any) => {
    if (typeof factory === 'function') return factory(stubTheme)
    return factory
  },
  configure: () => {},
}

export function useUnistyles() {
  return { theme: stubTheme, rt: {} }
}
