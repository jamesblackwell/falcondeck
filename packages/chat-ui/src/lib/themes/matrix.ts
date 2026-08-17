import type { ThemeRegistrationAny } from 'shiki/core'

/** FalconDeck's quieter take on digital rain: green remains dominant without
 * turning long transcript copy into a wall of maximum-chroma neon. */
const matrixTheme = {
  name: 'falcondeck-matrix',
  displayName: 'FalconDeck Matrix',
  type: 'dark',
  fg: '#d8f7df',
  bg: '#0b120d',
  colors: {
    'editor.background': '#0b120d',
    'editor.foreground': '#d8f7df',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#78947f', fontStyle: 'italic' } },
    { scope: ['string', 'markup.inline.raw'], settings: { foreground: '#55d982' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: '#f0ba69' } },
    { scope: ['keyword', 'storage', 'storage.type'], settings: { foreground: '#bf8cff' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#59bff5' } },
    { scope: ['entity.name.type', 'support.type', 'entity.name.class'], settings: { foreground: '#e0dd72' } },
    { scope: ['variable', 'meta.object-literal.key'], settings: { foreground: '#d8f7df' } },
    { scope: ['variable.other.property', 'support.variable.property'], settings: { foreground: '#5eead4' } },
    { scope: ['keyword.operator', 'punctuation.separator'], settings: { foreground: '#5eead4' } },
    { scope: ['markup.heading'], settings: { foreground: '#63d9ef', fontStyle: 'bold' } },
    { scope: ['markup.inserted'], settings: { foreground: '#77f29b' } },
    { scope: ['markup.deleted', 'invalid'], settings: { foreground: '#ff7373' } },
  ],
} satisfies ThemeRegistrationAny

export default matrixTheme
