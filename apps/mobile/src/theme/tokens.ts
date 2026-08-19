/**
 * FalconDeck design tokens for React Native.
 * Mirrors packages/ui/src/styles.css with mobile-appropriate sizing.
 *
 * Colors, spacing, radii, and shadows are 1:1 with the web design system.
 * Font sizes are scaled up slightly for mobile readability (native text
 * renders smaller than web at the same px value).
 */
export const darkColors = {
  // Background depth scale
  surface: {
    0: '#09090b',
    1: '#111113',
    2: '#1a1a1f',
    3: '#232329',
    4: '#2c2c34',
  },

  // Foreground / text contrast scale. tertiary and muted carry real copy, so
  // they clear WCAG AA (≥4.5:1) on surface 1; faint is decorative-only.
  fg: {
    primary: '#f4f4f6',
    secondary: '#c4c4cc',
    tertiary: '#9d9da8',
    muted: '#84848f',
    faint: '#6d6d78',
  },

  // Borders (solid approximations of rgba on dark bg)
  border: {
    subtle: '#1a1a1f',
    default: '#232329',
    emphasis: '#2c2c34',
    strong: '#3a3a44',
  },

  // Accent — Emerald
  accent: {
    default: '#34d399',
    muted: 'rgba(52, 211, 153, 0.14)',
    strong: '#6ee7b7',
    dim: 'rgba(52, 211, 153, 0.07)',
  },

  // Semantic
  success: { default: '#34d399', muted: 'rgba(52, 211, 153, 0.12)' },
  warning: { default: '#fbbf24', muted: 'rgba(251, 191, 36, 0.12)' },
  danger: { default: '#f87171', muted: 'rgba(248, 113, 113, 0.12)' },
  info: { default: '#60a5fa', muted: 'rgba(96, 165, 250, 0.12)' },
  cat: { 1: '#f87171', 2: '#fb923c', 3: '#fbbf24', 4: '#a3e635', 5: '#34d399', 6: '#2dd4bf', 7: '#22d3ee', 8: '#60a5fa', 9: '#818cf8', 10: '#a78bfa', 11: '#e879f9', 12: '#f472b6' },

  // Diff
  diff: {
    added: 'rgba(52, 211, 153, 0.12)',
    removed: 'rgba(248, 113, 113, 0.12)',
    addedText: '#6ee7b7',
    removedText: '#fca5a5',
  },

  // Overlay / scrim — mirrors --fd-overlay / --fd-overlay-strong on web.
  // `overlay` backs centered dialogs and option sheets; `overlayStrong` backs
  // full-screen drawers and is always paired with a blur.
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(9, 9, 11, 0.8)',

  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// Light palette — mirrors the light theme in packages/ui/src/styles.css.
// Same shape as darkColors so unistyles themes stay interchangeable.
export const lightColors: typeof darkColors = {
  surface: {
    0: '#f4f4f5',
    1: '#fbfbfc',
    2: '#ffffff',
    3: '#ececef',
    4: '#e1e1e5',
  },

  fg: {
    primary: '#17171c',
    secondary: '#3c3c44',
    tertiary: '#5a5a64',
    muted: '#71717c',
    faint: '#8f8f9a',
  },

  // Solid approximations of rgba(17,17,20,…) over the light surfaces
  border: {
    subtle: '#ebebec',
    default: '#e3e3e5',
    emphasis: '#d8d8da',
    strong: '#c8c8cb',
  },

  // Emerald deepens on light surfaces to keep contrast
  accent: {
    default: '#059669',
    muted: 'rgba(5, 150, 105, 0.12)',
    strong: '#047857',
    dim: 'rgba(5, 150, 105, 0.06)',
  },

  success: { default: '#059669', muted: 'rgba(5, 150, 105, 0.10)' },
  warning: { default: '#b45309', muted: 'rgba(180, 83, 9, 0.10)' },
  danger: { default: '#dc2626', muted: 'rgba(220, 38, 38, 0.08)' },
  info: { default: '#2563eb', muted: 'rgba(37, 99, 235, 0.08)' },
  cat: { 1: '#dc2626', 2: '#ea580c', 3: '#b45309', 4: '#65a30d', 5: '#059669', 6: '#0f766e', 7: '#0891b2', 8: '#2563eb', 9: '#4f46e5', 10: '#7c3aed', 11: '#c026d3', 12: '#db2777' },

  diff: {
    added: 'rgba(5, 150, 105, 0.10)',
    removed: 'rgba(220, 38, 38, 0.08)',
    addedText: '#047857',
    removedText: '#b91c1c',
  },

  overlay: 'rgba(23, 23, 28, 0.32)',
  overlayStrong: 'rgba(250, 250, 251, 0.85)',

  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Gruvbox-inspired palettes — mirror packages/ui/src/styles.css ---

export const gruvboxDarkColors: typeof darkColors = {
  surface: { 0: '#1d2021', 1: '#282828', 2: '#32302f', 3: '#3c3836', 4: '#504945' },
  fg: {
    primary: '#fbf1c7',
    secondary: '#ebdbb2',
    tertiary: '#c8b998',
    muted: '#b0a184',
    faint: '#8f8371',
  },
  border: { subtle: '#32302f', default: '#3c3836', emphasis: '#504945', strong: '#665c54' },
  accent: {
    default: '#8ec07c',
    muted: 'rgba(142, 192, 124, 0.14)',
    strong: '#a5d18f',
    dim: 'rgba(142, 192, 124, 0.07)',
  },
  success: { default: '#b8bb26', muted: 'rgba(184, 187, 38, 0.12)' },
  warning: { default: '#fabd2f', muted: 'rgba(250, 189, 47, 0.12)' },
  danger: { default: '#fb4934', muted: 'rgba(251, 73, 52, 0.12)' },
  info: { default: '#83a598', muted: 'rgba(131, 165, 152, 0.12)' },
  cat: { 1: '#fb4934', 2: '#fe8019', 3: '#fabd2f', 4: '#b8bb26', 5: '#8ec07c', 6: '#83a598', 7: '#458588', 8: '#d3869b', 9: '#b16286', 10: '#8f3f71', 11: '#d65d0e', 12: '#689d6a' },
  diff: {
    added: 'rgba(184, 187, 38, 0.12)',
    removed: 'rgba(251, 73, 52, 0.12)',
    addedText: '#b8bb26',
    removedText: '#fb4934',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(29, 32, 33, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const gruvboxLightColors: typeof darkColors = {
  surface: { 0: '#f2e5bc', 1: '#f9efc6', 2: '#fbf1c7', 3: '#e7d8ac', 4: '#d5c4a1' },
  fg: {
    primary: '#282828',
    secondary: '#3c3836',
    tertiary: '#504945',
    muted: '#665c54',
    faint: '#857a6e',
  },
  border: { subtle: '#e5d7ae', default: '#dccfa6', emphasis: '#cfc19a', strong: '#bcae89' },
  accent: {
    default: '#427b58',
    muted: 'rgba(66, 123, 88, 0.14)',
    strong: '#356449',
    dim: 'rgba(66, 123, 88, 0.07)',
  },
  success: { default: '#79740e', muted: 'rgba(121, 116, 14, 0.12)' },
  warning: { default: '#b57614', muted: 'rgba(181, 118, 20, 0.12)' },
  danger: { default: '#cc241d', muted: 'rgba(204, 36, 29, 0.10)' },
  info: { default: '#076678', muted: 'rgba(7, 102, 120, 0.10)' },
  cat: { 1: '#cc241d', 2: '#d65d0e', 3: '#b57614', 4: '#79740e', 5: '#427b58', 6: '#076678', 7: '#458588', 8: '#b16286', 9: '#8f3f71', 10: '#9d0006', 11: '#af3a03', 12: '#689d6a' },
  diff: {
    added: 'rgba(121, 116, 14, 0.12)',
    removed: 'rgba(204, 36, 29, 0.10)',
    addedText: '#79740e',
    removedText: '#9d0006',
  },
  overlay: 'rgba(40, 40, 40, 0.32)',
  overlayStrong: 'rgba(251, 241, 199, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Tokyo Night-inspired palettes — mirror packages/ui/src/styles.css ---

export const tokyoNightDarkColors: typeof darkColors = {
  surface: { 0: '#16161e', 1: '#1a1b26', 2: '#24283b', 3: '#292e42', 4: '#3b4261' },
  fg: {
    primary: '#c0caf5',
    secondary: '#a9b1d6',
    tertiary: '#939bc4',
    muted: '#8189af',
    faint: '#666d92',
  },
  border: { subtle: '#24283b', default: '#292e42', emphasis: '#3b4261', strong: '#4a5378' },
  accent: {
    default: '#7aa2f7',
    muted: 'rgba(122, 162, 247, 0.15)',
    strong: '#94b6fa',
    dim: 'rgba(122, 162, 247, 0.07)',
  },
  success: { default: '#9ece6a', muted: 'rgba(158, 206, 106, 0.12)' },
  warning: { default: '#e0af68', muted: 'rgba(224, 175, 104, 0.12)' },
  danger: { default: '#f7768e', muted: 'rgba(247, 118, 142, 0.12)' },
  info: { default: '#7dcfff', muted: 'rgba(125, 207, 255, 0.12)' },
  cat: { 1: '#f7768e', 2: '#ff9e64', 3: '#e0af68', 4: '#9ece6a', 5: '#73daca', 6: '#2ac3de', 7: '#7dcfff', 8: '#7aa2f7', 9: '#bb9af7', 10: '#c0caf5', 11: '#ff007c', 12: '#9d7cd8' },
  diff: {
    added: 'rgba(158, 206, 106, 0.12)',
    removed: 'rgba(247, 118, 142, 0.12)',
    addedText: '#9ece6a',
    removedText: '#f7768e',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(22, 22, 30, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const tokyoNightLightColors: typeof darkColors = {
  surface: { 0: '#d6d8e3', 1: '#e4e6ee', 2: '#eff1f7', 3: '#ced2e0', 4: '#bfc4d6' },
  fg: {
    primary: '#2e3350',
    secondary: '#40456b',
    tertiary: '#545a80',
    muted: '#5d648d',
    faint: '#7b82a6',
  },
  border: { subtle: '#d4d7e2', default: '#c9cdda', emphasis: '#bbc0d0', strong: '#a6acc1' },
  accent: {
    default: '#2e7de9',
    muted: 'rgba(46, 125, 233, 0.13)',
    strong: '#1a63cf',
    dim: 'rgba(46, 125, 233, 0.06)',
  },
  success: { default: '#587539', muted: 'rgba(88, 117, 57, 0.12)' },
  warning: { default: '#8f5e15', muted: 'rgba(143, 94, 21, 0.12)' },
  danger: { default: '#c53963', muted: 'rgba(197, 57, 99, 0.10)' },
  info: { default: '#007197', muted: 'rgba(0, 113, 151, 0.10)' },
  cat: { 1: '#c53963', 2: '#d15a00', 3: '#8f5e15', 4: '#587539', 5: '#387268', 6: '#007197', 7: '#2e7de9', 8: '#2450b0', 9: '#7847bd', 10: '#5a30c2', 11: '#b8336a', 12: '#8c6c3e' },
  diff: {
    added: 'rgba(88, 117, 57, 0.12)',
    removed: 'rgba(197, 57, 99, 0.10)',
    addedText: '#587539',
    removedText: '#c53963',
  },
  overlay: 'rgba(46, 51, 80, 0.32)',
  overlayStrong: 'rgba(228, 230, 238, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Catppuccin-inspired palettes — mirror packages/ui/src/styles.css ---

export const catppuccinDarkColors: typeof darkColors = {
  surface: { 0: '#11111b', 1: '#1e1e2e', 2: '#282839', 3: '#313244', 4: '#45475a' },
  fg: {
    primary: '#cdd6f4',
    secondary: '#bac2de',
    tertiary: '#a6adc8',
    muted: '#9399b2',
    faint: '#7f849c',
  },
  border: { subtle: '#2a2b3c', default: '#313244', emphasis: '#3c3d50', strong: '#4c4e61' },
  accent: {
    default: '#cba6f7',
    muted: 'rgba(203, 166, 247, 0.14)',
    strong: '#dcc0ff',
    dim: 'rgba(203, 166, 247, 0.07)',
  },
  success: { default: '#a6e3a1', muted: 'rgba(166, 227, 161, 0.12)' },
  warning: { default: '#f9e2af', muted: 'rgba(249, 226, 175, 0.12)' },
  danger: { default: '#f38ba8', muted: 'rgba(243, 139, 168, 0.12)' },
  info: { default: '#89dceb', muted: 'rgba(137, 220, 235, 0.12)' },
  cat: { 1: '#f5e0dc', 2: '#f2cdcd', 3: '#f5c2e7', 4: '#cba6f7', 5: '#f38ba8', 6: '#eba0ac', 7: '#fab387', 8: '#f9e2af', 9: '#a6e3a1', 10: '#94e2d5', 11: '#89dceb', 12: '#74c7ec' },
  diff: {
    added: 'rgba(166, 227, 161, 0.12)',
    removed: 'rgba(243, 139, 168, 0.12)',
    addedText: '#a6e3a1',
    removedText: '#f38ba8',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(17, 17, 27, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const catppuccinLightColors: typeof darkColors = {
  surface: { 0: '#e6e9ef', 1: '#eff1f5', 2: '#ffffff', 3: '#dce0e8', 4: '#ccd0da' },
  fg: {
    primary: '#4c4f69',
    secondary: '#5c5f77',
    tertiary: '#666980',
    muted: '#6a6d80',
    faint: '#83869a',
  },
  border: { subtle: '#e0e2e8', default: '#d8dae1', emphasis: '#ced1d9', strong: '#bec0cb' },
  accent: {
    default: '#8839ef',
    muted: 'rgba(136, 57, 239, 0.14)',
    strong: '#7222d1',
    dim: 'rgba(136, 57, 239, 0.07)',
  },
  success: { default: '#3d8f2b', muted: 'rgba(61, 143, 43, 0.11)' },
  warning: { default: '#a86e12', muted: 'rgba(168, 110, 18, 0.11)' },
  danger: { default: '#d20f39', muted: 'rgba(210, 15, 57, 0.11)' },
  info: { default: '#0c7a8f', muted: 'rgba(12, 122, 143, 0.11)' },
  cat: { 1: '#dc8a78', 2: '#dd7878', 3: '#ea76cb', 4: '#8839ef', 5: '#d20f39', 6: '#e64553', 7: '#fe640b', 8: '#df8e1d', 9: '#40a02b', 10: '#179299', 11: '#04a5e5', 12: '#209fb5' },
  diff: {
    added: 'rgba(61, 143, 43, 0.11)',
    removed: 'rgba(210, 15, 57, 0.11)',
    addedText: '#3d8f2b',
    removedText: '#d20f39',
  },
  overlay: 'rgba(76, 79, 105, 0.32)',
  overlayStrong: 'rgba(239, 241, 245, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Nord-inspired palettes — mirror packages/ui/src/styles.css ---

export const nordDarkColors: typeof darkColors = {
  surface: { 0: '#242933', 1: '#2e3440', 2: '#3b4252', 3: '#434c5e', 4: '#4c566a' },
  fg: {
    primary: '#eceff4',
    secondary: '#e5e9f0',
    tertiary: '#d8dee9',
    muted: '#b6c0cf',
    faint: '#98a3b5',
  },
  border: { subtle: '#3a404c', default: '#414753', emphasis: '#4b515d', strong: '#5a606c' },
  accent: {
    default: '#88c0d0',
    muted: 'rgba(136, 192, 208, 0.14)',
    strong: '#a3d5e3',
    dim: 'rgba(136, 192, 208, 0.07)',
  },
  success: { default: '#a3be8c', muted: 'rgba(163, 190, 140, 0.12)' },
  warning: { default: '#ebcb8b', muted: 'rgba(235, 203, 139, 0.12)' },
  danger: { default: '#cb7f88', muted: 'rgba(203, 127, 136, 0.12)' },
  info: { default: '#81a1c1', muted: 'rgba(129, 161, 193, 0.12)' },
  cat: { 1: '#bf616a', 2: '#d08770', 3: '#ebcb8b', 4: '#a3be8c', 5: '#8fbcbb', 6: '#88c0d0', 7: '#81a1c1', 8: '#5e81ac', 9: '#b48ead', 10: '#eceff4', 11: '#d8dee9', 12: '#e5e9f0' },
  diff: {
    added: 'rgba(163, 190, 140, 0.12)',
    removed: 'rgba(203, 127, 136, 0.12)',
    addedText: '#a3be8c',
    removedText: '#cb7f88',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(36, 41, 51, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const nordLightColors: typeof darkColors = {
  surface: { 0: '#dfe4ee', 1: '#e9edf4', 2: '#f8fafc', 3: '#dae0ec', 4: '#cfd6e4' },
  fg: {
    primary: '#2e3440',
    secondary: '#3b4252',
    tertiary: '#434c5e',
    muted: '#4c566a',
    faint: '#77839a',
  },
  border: { subtle: '#d8dce4', default: '#cfd3db', emphasis: '#c4c8d0', strong: '#b1b5be' },
  accent: {
    default: '#4c6f96',
    muted: 'rgba(76, 111, 150, 0.14)',
    strong: '#3b587a',
    dim: 'rgba(76, 111, 150, 0.07)',
  },
  success: { default: '#55702f', muted: 'rgba(85, 112, 47, 0.11)' },
  warning: { default: '#8a6414', muted: 'rgba(138, 100, 20, 0.11)' },
  danger: { default: '#a3383f', muted: 'rgba(163, 56, 63, 0.11)' },
  info: { default: '#3d6a86', muted: 'rgba(61, 106, 134, 0.11)' },
  cat: { 1: '#a3383f', 2: '#b56a46', 3: '#8a6414', 4: '#55702f', 5: '#3d6a86', 6: '#4c6f96', 7: '#5e81ac', 8: '#3b4252', 9: '#8f6f97', 10: '#2e3440', 11: '#434c5e', 12: '#4c566a' },
  diff: {
    added: 'rgba(85, 112, 47, 0.11)',
    removed: 'rgba(163, 56, 63, 0.11)',
    addedText: '#55702f',
    removedText: '#a3383f',
  },
  overlay: 'rgba(46, 52, 64, 0.32)',
  overlayStrong: 'rgba(233, 237, 244, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Dracula-inspired palettes — mirror packages/ui/src/styles.css ---

export const draculaDarkColors: typeof darkColors = {
  surface: { 0: '#21222c', 1: '#282a36', 2: '#343746', 3: '#44475a', 4: '#565973' },
  fg: {
    primary: '#f8f8f2',
    secondary: '#dedee0',
    tertiary: '#bcbdc9',
    muted: '#a0a4c0',
    faint: '#868bab',
  },
  border: { subtle: '#373843', default: '#3f414b', emphasis: '#4b4d56', strong: '#5e6067' },
  accent: {
    default: '#bd93f9',
    muted: 'rgba(189, 147, 249, 0.14)',
    strong: '#d3b4ff',
    dim: 'rgba(189, 147, 249, 0.07)',
  },
  success: { default: '#50fa7b', muted: 'rgba(80, 250, 123, 0.12)' },
  warning: { default: '#ffb86c', muted: 'rgba(255, 184, 108, 0.12)' },
  danger: { default: '#ff5555', muted: 'rgba(255, 85, 85, 0.12)' },
  info: { default: '#8be9fd', muted: 'rgba(139, 233, 253, 0.12)' },
  cat: { 1: '#ff5555', 2: '#ffb86c', 3: '#f1fa8c', 4: '#50fa7b', 5: '#8be9fd', 6: '#bd93f9', 7: '#ff79c6', 8: '#6272a4', 9: '#ff6e6e', 10: '#a4ffff', 11: '#caa9fa', 12: '#f8f8f2' },
  diff: {
    added: 'rgba(80, 250, 123, 0.12)',
    removed: 'rgba(255, 85, 85, 0.12)',
    addedText: '#50fa7b',
    removedText: '#ff5555',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(33, 34, 44, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const draculaLightColors: typeof darkColors = {
  surface: { 0: '#f2eeda', 1: '#fbf8e8', 2: '#fffbeb', 3: '#eae5cf', 4: '#dcd6bc' },
  fg: {
    primary: '#1f1f1f',
    secondary: '#3a3728',
    tertiary: '#55503a',
    muted: '#6c664b',
    faint: '#8a8368',
  },
  border: { subtle: '#e7e4d6', default: '#dcdacc', emphasis: '#cfcdc0', strong: '#b9b7ac' },
  accent: {
    default: '#644ac9',
    muted: 'rgba(100, 74, 201, 0.14)',
    strong: '#4f39a8',
    dim: 'rgba(100, 74, 201, 0.07)',
  },
  success: { default: '#14710a', muted: 'rgba(20, 113, 10, 0.11)' },
  warning: { default: '#a34d14', muted: 'rgba(163, 77, 20, 0.11)' },
  danger: { default: '#cb3a2a', muted: 'rgba(203, 58, 42, 0.11)' },
  info: { default: '#036a96', muted: 'rgba(3, 106, 150, 0.11)' },
  cat: { 1: '#cb3a2a', 2: '#a34d14', 3: '#8a6800', 4: '#14710a', 5: '#036a96', 6: '#644ac9', 7: '#c41c7a', 8: '#4a4e6a', 9: '#b42318', 10: '#0f6f8a', 11: '#4f39a8', 12: '#1f1f1f' },
  diff: {
    added: 'rgba(20, 113, 10, 0.11)',
    removed: 'rgba(203, 58, 42, 0.11)',
    addedText: '#14710a',
    removedText: '#cb3a2a',
  },
  overlay: 'rgba(31, 31, 31, 0.32)',
  overlayStrong: 'rgba(251, 248, 232, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Solarized-inspired palettes — mirror packages/ui/src/styles.css ---

export const solarizedDarkColors: typeof darkColors = {
  surface: { 0: '#00212b', 1: '#002b36', 2: '#073642', 3: '#0d4552', 4: '#155969' },
  fg: {
    primary: '#fdf6e3',
    secondary: '#eee8d5',
    tertiary: '#93a1a1',
    muted: '#87999b',
    faint: '#6f8288',
  },
  border: { subtle: '#0a333d', default: '#103842', emphasis: '#193f48', strong: '#264a52' },
  accent: {
    default: '#268bd2',
    muted: 'rgba(38, 139, 210, 0.14)',
    strong: '#57a8e0',
    dim: 'rgba(38, 139, 210, 0.07)',
  },
  success: { default: '#859900', muted: 'rgba(133, 153, 0, 0.12)' },
  warning: { default: '#b58900', muted: 'rgba(181, 137, 0, 0.12)' },
  danger: { default: '#e5534e', muted: 'rgba(229, 83, 78, 0.12)' },
  info: { default: '#2aa198', muted: 'rgba(42, 161, 152, 0.12)' },
  cat: { 1: '#dc322f', 2: '#cb4b16', 3: '#b58900', 4: '#859900', 5: '#2aa198', 6: '#268bd2', 7: '#6c71c4', 8: '#d33682', 9: '#93a1a1', 10: '#eee8d5', 11: '#fdf6e3', 12: '#2aa198' },
  diff: {
    added: 'rgba(133, 153, 0, 0.12)',
    removed: 'rgba(229, 83, 78, 0.12)',
    addedText: '#859900',
    removedText: '#e5534e',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(0, 33, 43, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const solarizedLightColors: typeof darkColors = {
  surface: { 0: '#eee8d5', 1: '#f8f2e0', 2: '#fdf6e3', 3: '#e6dfc8', 4: '#d9d2ba' },
  fg: {
    primary: '#002b36',
    secondary: '#073642',
    tertiary: '#4e646b',
    muted: '#5b7176',
    faint: '#7b8d90',
  },
  border: { subtle: '#e2e0d1', default: '#d5d6c8', emphasis: '#c6cabe', strong: '#aeb6ad' },
  accent: {
    default: '#1a6c9c',
    muted: 'rgba(26, 108, 156, 0.14)',
    strong: '#0f5578',
    dim: 'rgba(26, 108, 156, 0.07)',
  },
  success: { default: '#5f6f00', muted: 'rgba(95, 111, 0, 0.11)' },
  warning: { default: '#8a6800', muted: 'rgba(138, 104, 0, 0.11)' },
  danger: { default: '#c62d2a', muted: 'rgba(198, 45, 42, 0.11)' },
  info: { default: '#1f7d76', muted: 'rgba(31, 125, 118, 0.11)' },
  cat: { 1: '#c62d2a', 2: '#cb4b16', 3: '#8a6800', 4: '#5f6f00', 5: '#1f7d76', 6: '#1a6c9c', 7: '#6c71c4', 8: '#d33682', 9: '#5b7176', 10: '#002b36', 11: '#073642', 12: '#268bd2' },
  diff: {
    added: 'rgba(95, 111, 0, 0.11)',
    removed: 'rgba(198, 45, 42, 0.11)',
    addedText: '#5f6f00',
    removedText: '#c62d2a',
  },
  overlay: 'rgba(0, 43, 54, 0.32)',
  overlayStrong: 'rgba(248, 242, 224, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- One-inspired palettes — mirror packages/ui/src/styles.css ---

export const oneDarkColors: typeof darkColors = {
  surface: { 0: '#21252b', 1: '#282c34', 2: '#31353f', 3: '#3a3f4b', 4: '#464c59' },
  fg: {
    primary: '#dcdfe4',
    secondary: '#b6bdc9',
    tertiary: '#a2aab8',
    muted: '#8f97a5',
    faint: '#767e8d',
  },
  border: { subtle: '#31353e', default: '#363b43', emphasis: '#3e434c', strong: '#4a4f58' },
  accent: {
    default: '#61afef',
    muted: 'rgba(97, 175, 239, 0.14)',
    strong: '#8ac6f5',
    dim: 'rgba(97, 175, 239, 0.07)',
  },
  success: { default: '#98c379', muted: 'rgba(152, 195, 121, 0.12)' },
  warning: { default: '#e5c07b', muted: 'rgba(229, 192, 123, 0.12)' },
  danger: { default: '#e06c75', muted: 'rgba(224, 108, 117, 0.12)' },
  info: { default: '#56b6c2', muted: 'rgba(86, 182, 194, 0.12)' },
  cat: { 1: '#e06c75', 2: '#d19a66', 3: '#e5c07b', 4: '#98c379', 5: '#56b6c2', 6: '#61afef', 7: '#c678dd', 8: '#be5046', 9: '#abb2bf', 10: '#c24038', 11: '#528bff', 12: '#a9a1e1' },
  diff: {
    added: 'rgba(152, 195, 121, 0.12)',
    removed: 'rgba(224, 108, 117, 0.12)',
    addedText: '#98c379',
    removedText: '#e06c75',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(33, 37, 43, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const oneLightColors: typeof darkColors = {
  surface: { 0: '#e5e5e6', 1: '#f2f2f3', 2: '#fafafa', 3: '#e0e0e2', 4: '#d3d3d6' },
  fg: {
    primary: '#383a42',
    secondary: '#494b53',
    tertiary: '#5b5d64',
    muted: '#6b6d74',
    faint: '#86888e',
  },
  border: { subtle: '#e1e1e3', default: '#d8d8da', emphasis: '#cdcdd0', strong: '#babbbe' },
  accent: {
    default: '#3568d4',
    muted: 'rgba(53, 104, 212, 0.14)',
    strong: '#2450b0',
    dim: 'rgba(53, 104, 212, 0.07)',
  },
  success: { default: '#3f7f3e', muted: 'rgba(63, 127, 62, 0.11)' },
  warning: { default: '#9a6700', muted: 'rgba(154, 103, 0, 0.11)' },
  danger: { default: '#ca1243', muted: 'rgba(202, 18, 67, 0.11)' },
  info: { default: '#0169a0', muted: 'rgba(1, 105, 160, 0.11)' },
  cat: { 1: '#ca1243', 2: '#c18401', 3: '#9a6700', 4: '#3f7f3e', 5: '#0169a0', 6: '#3568d4', 7: '#a626a4', 8: '#e45649', 9: '#383a42', 10: '#a626a4', 11: '#2450b0', 12: '#0184bc' },
  diff: {
    added: 'rgba(63, 127, 62, 0.11)',
    removed: 'rgba(202, 18, 67, 0.11)',
    addedText: '#3f7f3e',
    removedText: '#ca1243',
  },
  overlay: 'rgba(56, 58, 66, 0.32)',
  overlayStrong: 'rgba(242, 242, 243, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Rosé Pine-inspired palettes — mirror packages/ui/src/styles.css ---

export const rosePineDarkColors: typeof darkColors = {
  surface: { 0: '#16141f', 1: '#191724', 2: '#1f1d2e', 3: '#26233a', 4: '#403d52' },
  fg: {
    primary: '#e0def4',
    secondary: '#cbc7e2',
    tertiary: '#a9a5c4',
    muted: '#928eae',
    faint: '#7c7896',
  },
  border: { subtle: '#272533', default: '#2f2d3b', emphasis: '#3b3947', strong: '#4d4b5a' },
  accent: {
    default: '#c4a7e7',
    muted: 'rgba(196, 167, 231, 0.14)',
    strong: '#d7bff5',
    dim: 'rgba(196, 167, 231, 0.07)',
  },
  success: { default: '#9ccfd8', muted: 'rgba(156, 207, 216, 0.12)' },
  warning: { default: '#f6c177', muted: 'rgba(246, 193, 119, 0.12)' },
  danger: { default: '#eb6f92', muted: 'rgba(235, 111, 146, 0.12)' },
  info: { default: '#7fb4cd', muted: 'rgba(127, 180, 205, 0.12)' },
  cat: { 1: '#eb6f92', 2: '#f6c177', 3: '#ebbcba', 4: '#31748f', 5: '#9ccfd8', 6: '#c4a7e7', 7: '#e0def4', 8: '#908caa', 9: '#ea9a97', 10: '#3e8fb0', 11: '#b4637a', 12: '#fad9a1' },
  diff: {
    added: 'rgba(156, 207, 216, 0.12)',
    removed: 'rgba(235, 111, 146, 0.12)',
    addedText: '#9ccfd8',
    removedText: '#eb6f92',
  },
  overlay: 'rgba(0, 0, 0, 0.45)',
  overlayStrong: 'rgba(22, 20, 31, 0.8)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

export const rosePineLightColors: typeof darkColors = {
  surface: { 0: '#f2e9e1', 1: '#faf4ed', 2: '#fffaf3', 3: '#ece0d8', 4: '#dfdad9' },
  fg: {
    primary: '#4a4566',
    secondary: '#575279',
    tertiary: '#666189',
    muted: '#716d86',
    faint: '#8e89a0',
  },
  border: { subtle: '#ebe5e3', default: '#e3dddd', emphasis: '#d9d4d6', strong: '#c9c3ca' },
  accent: {
    default: '#907aa9',
    muted: 'rgba(144, 122, 169, 0.14)',
    strong: '#79648f',
    dim: 'rgba(144, 122, 169, 0.07)',
  },
  success: { default: '#43808c', muted: 'rgba(67, 128, 140, 0.11)' },
  warning: { default: '#a3711a', muted: 'rgba(163, 113, 26, 0.11)' },
  danger: { default: '#b4637a', muted: 'rgba(180, 99, 122, 0.11)' },
  info: { default: '#286983', muted: 'rgba(40, 105, 131, 0.11)' },
  cat: { 1: '#b4637a', 2: '#a3711a', 3: '#d7827e', 4: '#286983', 5: '#56949f', 6: '#907aa9', 7: '#575279', 8: '#6e6a86', 9: '#c17a7e', 10: '#3e8fb0', 11: '#907aa9', 12: '#ea9d34' },
  diff: {
    added: 'rgba(67, 128, 140, 0.11)',
    removed: 'rgba(180, 99, 122, 0.11)',
    addedText: '#43808c',
    removedText: '#b4637a',
  },
  overlay: 'rgba(74, 69, 102, 0.32)',
  overlayStrong: 'rgba(250, 244, 237, 0.85)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// --- Matrix-inspired (dark only) ---

export const matrixDarkColors: typeof darkColors = {
  surface: { 0: '#060a07', 1: '#0b120d', 2: '#111b13', 3: '#18271b', 4: '#223625' },
  fg: {
    primary: '#d8f7df',
    secondary: '#b4d8bc',
    tertiary: '#91b39a',
    muted: '#78947f',
    faint: '#5d7462',
  },
  border: { subtle: '#101b13', default: '#17271b', emphasis: '#213724', strong: '#315039' },
  accent: {
    default: '#35f477',
    muted: 'rgba(53, 244, 119, 0.14)',
    strong: '#77ff9f',
    dim: 'rgba(53, 244, 119, 0.07)',
  },
  success: { default: '#55d982', muted: 'rgba(85, 217, 130, 0.12)' },
  warning: { default: '#e0dd72', muted: 'rgba(224, 221, 114, 0.12)' },
  danger: { default: '#ff7373', muted: 'rgba(255, 115, 115, 0.12)' },
  info: { default: '#59bff5', muted: 'rgba(89, 191, 245, 0.12)' },
  cat: { 1: '#ff7373', 2: '#ffb070', 3: '#e0dd72', 4: '#35f477', 5: '#55d982', 6: '#7dffb0', 7: '#59bff5', 8: '#7ec8ff', 9: '#b4a7ff', 10: '#e0aaff', 11: '#ff8ad4', 12: '#a3e635' },
  diff: {
    added: 'rgba(85, 217, 130, 0.12)',
    removed: 'rgba(255, 115, 115, 0.12)',
    addedText: '#77f29b',
    removedText: '#ff8e8e',
  },
  overlay: 'rgba(0, 0, 0, 0.5)',
  overlayStrong: 'rgba(6, 10, 7, 0.84)',
  transparent: 'transparent',
  white: '#ffffff',
  black: '#000000',
}

// Back-compat alias — prefer reading colors from the active unistyles theme
// (`useUnistyles().theme.colors`) so light mode is respected.
export const colors = darkColors

export const spacing = {
  0: 0,
  px: 1,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  full: 999,
} as const

// Mobile font sizes — scaled from the web design system for native readability.
// The whole ramp runs a step above the web values: phone reading distance and
// glare make web-sized body copy feel cramped, and the metadata sizes ('2xs',
// xs) were the worst of it. Users who want the old density pick "Small" in
// Appearance, which scales this ramp back down by 0.9.
export const fontSize = {
  '2xs': 11,
  xs: 13,
  sm: 15,
  base: 17,
  md: 18,
  lg: 21,
  xl: 24,
  '2xl': 28,
  '3xl': 34,
} as const

export const lineHeight = {
  tight: 1.25,
  normal: 1.5,
  relaxed: 1.65,
  // Code sets tighter than prose: monospace lines are short and scanned
  // vertically, so prose leading leaves a block looking loose and unstructured.
  code: 1.55,
} as const

// Bundled with the app via the expo-font config plugin in app.config.ts, so
// both families resolve on device and match the desktop client. These names
// are the fonts' own family names on iOS and the generated XML family names on
// Android; changing either side without the other silently falls back to the
// system face — which for `mono` means losing monospacing entirely.
export const fontFamily = {
  sans: 'Geist',
  mono: 'Geist Mono',
} as const

export const shadow = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.4,
    shadowRadius: 40,
    elevation: 12,
  },
}

export const duration = {
  fast: 100,
  normal: 150,
  slow: 250,
} as const

export const iconSize = {
  // xs is the dense inline size used inside list rows and disclosure headers.
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
} as const

// Minimum touch target per Apple HIG / Material. Pair with hitSlop when the
// painted control is smaller than this.
export const minTouchTarget = 44
