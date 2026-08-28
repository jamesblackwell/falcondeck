import * as Clipboard from 'expo-clipboard'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-test-renderer'

import { cleanup, renderComponent, textOf } from '@/test/render'
import {
  __resetWebViewMock,
  __setWebViewMessage,
} from 'react-native-webview'

import { MermaidBlock } from './MermaidBlock'
import { setMermaidAssetLoader } from './mermaidEngine'

const SOURCE = 'flowchart TD\n  home --> studio'

describe('MermaidBlock', () => {
  beforeEach(() => {
    __resetWebViewMock()
    setMermaidAssetLoader(async () => 'window.mermaid={}')
  })

  afterEach(() => {
    setMermaidAssetLoader(null)
    __resetWebViewMock()
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders a mermaid diagram once the engine loads', async () => {
    const renderer = renderComponent(<MermaidBlock code={SOURCE} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(textOf(renderer)).toContain('mermaid')
    expect(textOf(renderer)).toContain('Source')
    expect(textOf(renderer)).not.toContain('home --> studio')
  })

  it('toggles back to the source', async () => {
    const renderer = renderComponent(<MermaidBlock code={SOURCE} />)
    await act(async () => {
      await Promise.resolve()
    })
    const toggle = renderer.root.findByProps({
      accessibilityLabel: 'Show source',
    })
    act(() => toggle.props.onPress())
    expect(textOf(renderer)).toContain('home --> studio')
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Show diagram' }),
    ).toBeDefined()
  })

  it('falls back to source when mermaid reports an error', async () => {
    __setWebViewMessage({ type: 'error', message: 'Parse error' })
    const renderer = renderComponent(<MermaidBlock code={SOURCE} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(textOf(renderer)).toContain('Could not render')
    expect(textOf(renderer)).toContain('home --> studio')
  })

  it('ignores malformed webview messages', async () => {
    __setWebViewMessage('not-json')
    const renderer = renderComponent(<MermaidBlock code={SOURCE} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(textOf(renderer)).toContain('Source')
    expect(textOf(renderer)).not.toContain('Could not render')
  })

  it('falls back when the mermaid engine cannot load', async () => {
    setMermaidAssetLoader(async () => {
      throw new Error('missing engine')
    })
    const renderer = renderComponent(<MermaidBlock code={SOURCE} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(textOf(renderer)).toContain('Could not render')
    expect(textOf(renderer)).toContain('home --> studio')
  })

  it('uses a generic error when the engine rejects with a non-error', async () => {
    setMermaidAssetLoader(async () => {
      throw 'offline'
    })
    const renderer = renderComponent(<MermaidBlock code={SOURCE} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(textOf(renderer)).toContain('Could not render')
  })

  it('hides the render error while the enclosing message is still pending', async () => {
    setMermaidAssetLoader(async () => {
      throw new Error('Parse error')
    })
    const renderer = renderComponent(
      <MermaidBlock code={'flowchart TD\n  A-->'} pending />,
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(textOf(renderer)).toContain('flowchart TD')
    expect(textOf(renderer)).not.toContain('Could not render')
  })

  it('keeps an empty fence as source without loading mermaid', async () => {
    const load = vi.fn(async () => 'window.mermaid={}')
    setMermaidAssetLoader(load)
    const renderer = renderComponent(<MermaidBlock code={'  \n'} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(load).not.toHaveBeenCalled()
    expect(textOf(renderer)).toContain('Copy')
    expect(textOf(renderer)).not.toContain('Source')
  })

  it('confirms a source copy after the native write resolves', async () => {
    const copy = vi.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true)
    const renderer = renderComponent(<MermaidBlock code={SOURCE} />)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Copy diagram source' })
        .props.onPress({})
      await Promise.resolve()
    })
    expect(copy).toHaveBeenCalledWith(SOURCE)
    expect(textOf(renderer)).toContain('Copied')
  })

  it('lets the user retry a failed source copy', async () => {
    vi.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(false)
    const renderer = renderComponent(<MermaidBlock code={SOURCE} />)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Copy diagram source' })
        .props.onPress({})
      await Promise.resolve()
    })
    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'Could not copy diagram source. Retry',
      }),
    ).toBeDefined()
  })
})
