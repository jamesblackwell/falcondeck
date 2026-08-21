import {
  mermaidRenderOptions,
  type MermaidPalette,
} from '@falcondeck/client-core'

type MermaidApi = {
  initialize: (config: ReturnType<typeof mermaidRenderOptions>) => void
  render: (
    id: string,
    source: string,
  ) => Promise<{ svg: string }>
}

let mermaidPromise: Promise<MermaidApi> | null = null
let diagramSeq = 0

function cssVar(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim()
}

export function readMermaidPalette(
  root: HTMLElement = document.documentElement,
): MermaidPalette {
  const styles = getComputedStyle(root)
  const cat = Array.from({ length: 12 }, (_, index) =>
    cssVar(styles, `--fd-cat-${index + 1}`),
  )
  return {
    darkMode: root.dataset.theme !== 'light',
    fontFamily: cssVar(styles, '--fd-font-sans'),
    background: cssVar(styles, '--fd-bg-1'),
    surface: cssVar(styles, '--fd-bg-2'),
    surfaceRaised: cssVar(styles, '--fd-bg-3'),
    surfaceHighest: cssVar(styles, '--fd-bg-4'),
    text: cssVar(styles, '--fd-fg-0'),
    textSecondary: cssVar(styles, '--fd-fg-1'),
    textMuted: cssVar(styles, '--fd-fg-3'),
    border: cssVar(styles, '--fd-border-2'),
    borderSubtle: cssVar(styles, '--fd-border-1'),
    accent: cssVar(styles, '--fd-accent'),
    danger: cssVar(styles, '--fd-danger'),
    cat,
  }
}

export function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((module) => module.default as unknown as MermaidApi)
      .catch((error) => {
        mermaidPromise = null
        throw error
      })
  }
  return mermaidPromise
}

export function nextMermaidId(): string {
  diagramSeq += 1
  return `fdm${diagramSeq}`
}

export async function renderMermaidSvg(
  source: string,
  palette: MermaidPalette = readMermaidPalette(),
): Promise<string> {
  const mermaid = await loadMermaid()
  mermaid.initialize(mermaidRenderOptions(palette))
  const { svg } = await mermaid.render(nextMermaidId(), source)
  return svg
}
