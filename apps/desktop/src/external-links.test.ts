import { createElement } from 'react'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { ToastProvider } from '@falcondeck/ui'
import * as api from './api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ExternalLinkHandler,
  installExternalLinkHandler,
  resolveExternalHref,
} from './external-links'

describe('resolveExternalHref', () => {
  const base = 'http://localhost:1420/'

  it('accepts absolute http(s) URLs', () => {
    expect(resolveExternalHref('https://falcondeck.com/docs', base)).toBe(
      'https://falcondeck.com/docs',
    )
    expect(resolveExternalHref('http://example.com', base)).toBe(
      'http://example.com/',
    )
  })

  it('accepts mailto and tel', () => {
    expect(resolveExternalHref('mailto:hi@example.com', base)).toBe(
      'mailto:hi@example.com',
    )
    expect(resolveExternalHref('tel:+15551212', base)).toBe('tel:+15551212')
  })

  it('rejects same-origin relative paths and hash links', () => {
    expect(resolveExternalHref('/settings', base)).toBeNull()
    expect(resolveExternalHref('#section', base)).toBeNull()
    expect(resolveExternalHref('', base)).toBeNull()
    expect(resolveExternalHref(null, base)).toBeNull()
  })

  it('rejects javascript and unsupported schemes', () => {
    expect(resolveExternalHref('javascript:alert(1)', base)).toBeNull()
    expect(resolveExternalHref('data:text/html,hi', base)).toBeNull()
    expect(resolveExternalHref('file:///etc/passwd', base)).toBeNull()
  })
})

describe('installExternalLinkHandler', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('opens external anchors via the provided opener and prevents default', async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)
    const uninstall = installExternalLinkHandler(openUrl)

    const anchor = document.createElement('a')
    anchor.href = 'https://example.com/path'
    anchor.textContent = 'Example'
    document.body.appendChild(anchor)

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    const prevented = !anchor.dispatchEvent(event)

    expect(prevented).toBe(true)
    await vi.waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://example.com/path')
    })

    uninstall()
  })

  it('ignores anchors opted out with data-external="false"', () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)
    const uninstall = installExternalLinkHandler(openUrl)

    const anchor = document.createElement('a')
    anchor.href = 'https://example.com'
    anchor.dataset.external = 'false'
    // The production handler must ignore this anchor; prevent jsdom's own
    // asynchronous navigation attempt after the capture phase so a successful
    // opt-out test does not emit a misleading console error.
    anchor.addEventListener('click', (event) => event.preventDefault())
    document.body.appendChild(anchor)

    anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    )

    expect(openUrl).not.toHaveBeenCalled()
    uninstall()
  })

  it('ignores hash-only anchors', () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)
    const uninstall = installExternalLinkHandler(openUrl)

    const anchor = document.createElement('a')
    anchor.href = '#top'
    document.body.appendChild(anchor)

    anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    )

    expect(openUrl).not.toHaveBeenCalled()
    uninstall()
  })

  it('shows a toast for a real failure without adding text to the message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(api, 'openExternalUrl').mockRejectedValue(new Error('No handler'))
    render(createElement(ToastProvider, null,
      createElement(ExternalLinkHandler),
      createElement('p', { 'data-testid': 'message' },
        'Built locally. ',
        createElement('a', { href: 'http://localhost:5173/' }, 'Open prototype'),
        '.',
      ),
    ))
    fireEvent.click(screen.getByText('Open prototype'))
    expect(await screen.findByText('Couldn’t open link')).toBeInTheDocument()
    expect(screen.getByTestId('message').textContent).toBe('Built locally. Open prototype.')
  })

  it('reports failures without modifying message markup and allows retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const openUrl = vi.fn().mockRejectedValueOnce(new Error('No handler')).mockResolvedValueOnce(undefined)
    const onError = vi.fn()
    const uninstall = installExternalLinkHandler(openUrl, onError)
    document.body.innerHTML = '<p>Built locally. <a href="http://localhost:5173" title="Prototype">Open prototype</a>.</p>'
    const original = document.body.innerHTML
    const anchor = document.querySelector('a')!
    const click = () => anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    click()
    // The opener runs during the click, preserving browser user activation.
    expect(openUrl).toHaveBeenCalledWith('http://localhost:5173/')
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(document.body.innerHTML).toBe(original)
    click()
    await Promise.resolve()
    expect(openUrl).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
    uninstall()
  })

  it('ignores failures from superseded attempts and uninstalled handlers', async () => {
    const pending: Array<(error: Error) => void> = []
    const openUrl = vi.fn(() => new Promise<void>((_resolve, reject) => pending.push(reject)))
    const onError = vi.fn()
    const uninstall = installExternalLinkHandler(openUrl, onError)
    document.body.innerHTML = '<a href="https://example.com">Example</a>'
    const click = () => document.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    click()
    click()
    pending[0](new Error('Stale'))
    await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()
    uninstall()
    pending[1](new Error('Unmounted'))
    await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()
  })
})
