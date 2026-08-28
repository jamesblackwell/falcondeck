import { afterEach, describe, expect, it, vi } from 'vitest'

const initialize = vi.fn()
const render = vi.fn(async (_id: string, _source: string) => ({
  svg: '<svg data-testid="mermaid-svg"></svg>',
}))

vi.mock('mermaid', () => ({
  default: {
    initialize,
    render,
  },
}))

import { nextMermaidId, readMermaidPalette, renderMermaidSvg } from './mermaid'

describe('readMermaidPalette', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.cssText = ''
  })

  it('reads FalconDeck tokens and treats anything but light as dark', () => {
    document.documentElement.style.setProperty('--fd-bg-1', '#111113')
    document.documentElement.style.setProperty('--fd-fg-0', '#f4f4f6')
    document.documentElement.style.setProperty('--fd-cat-1', '#f87171')
    document.documentElement.dataset.theme = 'dark'

    const palette = readMermaidPalette()
    expect(palette.darkMode).toBe(true)
    expect(palette.background).toBe('#111113')
    expect(palette.text).toBe('#f4f4f6')
    expect(palette.cat[0]).toBe('#f87171')
  })

  it('marks the light appearance as not dark', () => {
    document.documentElement.dataset.theme = 'light'
    expect(readMermaidPalette().darkMode).toBe(false)
  })
})

describe('renderMermaidSvg', () => {
  afterEach(() => {
    initialize.mockClear()
    render.mockReset()
    render.mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg"></svg>',
    })
  })

  it('initializes mermaid then renders with a unique id', async () => {
    const first = nextMermaidId()
    const svg = await renderMermaidSvg('flowchart TD\n  A-->B')
    expect(svg).toContain('svg')
    expect(initialize).toHaveBeenCalledOnce()
    expect(render).toHaveBeenCalledOnce()
    const id = render.mock.calls[0]?.[0] as string
    expect(id).toMatch(/^fdm\d+$/)
    expect(id).not.toBe(first)
  })

  it('rejects an empty svg payload instead of painting a blank diagram', async () => {
    render.mockImplementationOnce(async () => ({ svg: '' }))
    await expect(renderMermaidSvg('flowchart TD\n  A-->B')).rejects.toMatchObject({
      message: 'Could not render diagram',
    })
  })

  it('renders one diagram at a time', async () => {
    let inflight = 0
    let peak = 0
    render.mockImplementation(async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await Promise.resolve()
      inflight -= 1
      return { svg: '<svg data-testid="mermaid-svg"></svg>' }
    })

    await Promise.all([
      renderMermaidSvg('flowchart TD\n  A-->B'),
      renderMermaidSvg('flowchart TD\n  C-->D'),
    ])
    expect(peak).toBe(1)
  })
})
