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

const RENDER_TIMEOUT_MS = 12_000

let mermaidPromise: Promise<MermaidApi> | null = null
let renderChain: Promise<void> = Promise.resolve()

function mermaidApiFromModule(module: unknown): MermaidApi {
  const record = module as { default?: unknown }
  const first = record.default ?? module
  const nested = first as {
    default?: unknown
    initialize?: unknown
    render?: unknown
  }
  const api = (
    typeof nested.render === 'function' ? nested : nested.default
  ) as MermaidApi | undefined
  if (
    typeof api?.initialize !== 'function' ||
    typeof api?.render !== 'function'
  ) {
    throw new Error('Mermaid engine is unavailable')
  }
  return api
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error('Could not render diagram'))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = renderChain.then(task, task)
  renderChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

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
      .then((module) => mermaidApiFromModule(module))
      .catch((error) => {
        mermaidPromise = null
        throw error
      })
  }
  return mermaidPromise
}

export function nextMermaidId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `fdm-${globalThis.crypto.randomUUID()}`
  }
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure diagram identifiers are unavailable')
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return `fdm-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function removeMermaidArtifacts(id: string): void {
  document.getElementById(id)?.remove()
  document.getElementById(`d${id}`)?.remove()
  document.getElementById(`i${id}`)?.remove()
}

export async function renderMermaidSvg(
  source: string,
  palette: MermaidPalette = readMermaidPalette(),
): Promise<string> {
  const mermaid = await loadMermaid()
  return enqueueMermaidRender(async () => {
    const id = nextMermaidId()
    const render = (async () => {
      mermaid.initialize(mermaidRenderOptions(palette))
      const result = await mermaid.render(id, source)
      const svg = result?.svg
      if (typeof svg !== 'string' || !svg.includes('<svg')) {
        throw new Error('Could not render diagram')
      }
      return svg
    })()
    // Mermaid normally removes its temporary div. Clean all documented id
    // variants both immediately and if a timed-out render settles later.
    void render.then(
      () => removeMermaidArtifacts(id),
      () => removeMermaidArtifacts(id),
    )
    try {
      return await withTimeout(render, RENDER_TIMEOUT_MS, () =>
        removeMermaidArtifacts(id),
      )
    } finally {
      removeMermaidArtifacts(id)
    }
  })
}
