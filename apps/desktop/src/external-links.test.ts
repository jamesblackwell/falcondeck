import { afterEach, describe, expect, it, vi } from 'vitest'

import {
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

  it('keeps a rejected native handoff visible and retryable beside its link', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const openUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error('No system handler'))
      .mockResolvedValueOnce(undefined)
    const uninstall = installExternalLinkHandler(openUrl)

    const existingDescription = document.createElement('span')
    existingDescription.id = 'existing-link-description'
    const anchor = document.createElement('a')
    anchor.href = 'https://example.com/source'
    anchor.textContent = 'Provider source'
    anchor.title = 'Original title'
    anchor.setAttribute('aria-describedby', existingDescription.id)
    document.body.append(existingDescription, anchor)

    anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    )

    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-external-open-status="failed"]'),
      ).toHaveTextContent('Could not open link. Select it to retry.')
    })
    const status = document.querySelector<HTMLElement>(
      '[data-external-open-status="failed"]',
    )
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(anchor.getAttribute('aria-describedby')).toBe(
      `${existingDescription.id} ${status?.id}`,
    )
    expect(anchor).toHaveAttribute('title', 'Retry opening external link')

    anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    )
    expect(
      document.querySelector('[data-external-open-status="retrying"]'),
    ).toHaveTextContent('Opening link again…')

    await vi.waitFor(() => {
      expect(document.querySelector('[data-external-open-status]')).toBeNull()
    })
    expect(openUrl).toHaveBeenCalledTimes(2)
    expect(anchor).toHaveAttribute('aria-describedby', existingDescription.id)
    expect(anchor).toHaveAttribute('title', 'Original title')

    uninstall()
  })

  it('does not let an older failed attempt overwrite a newer successful retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let rejectOlderRetry!: (error: unknown) => void
    let resolveNewerRetry!: () => void
    const olderRetry = new Promise<void>((_resolve, reject) => {
      rejectOlderRetry = reject
    })
    const newerRetry = new Promise<void>((resolve) => {
      resolveNewerRetry = resolve
    })
    const openUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error('Initial failure'))
      .mockReturnValueOnce(olderRetry)
      .mockReturnValueOnce(newerRetry)
    const uninstall = installExternalLinkHandler(openUrl)
    const anchor = document.createElement('a')
    anchor.href = 'https://example.com/race'
    anchor.textContent = 'Race-safe source'
    document.body.appendChild(anchor)

    const click = () =>
      anchor.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      )
    click()
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-external-open-status="failed"]'),
      ).not.toBeNull()
    })

    click()
    click()
    resolveNewerRetry()
    await vi.waitFor(() => {
      expect(document.querySelector('[data-external-open-status]')).toBeNull()
    })
    rejectOlderRetry(new Error('Stale failure'))
    await Promise.resolve()
    await Promise.resolve()

    expect(document.querySelector('[data-external-open-status]')).toBeNull()
    expect(openUrl).toHaveBeenCalledTimes(3)
    uninstall()
  })

  it('removes injected failure feedback when the handler uninstalls', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const uninstall = installExternalLinkHandler(
      vi.fn().mockRejectedValue(new Error('No handler')),
    )
    const anchor = document.createElement('a')
    anchor.href = 'https://example.com/cleanup'
    anchor.textContent = 'Cleanup source'
    document.body.appendChild(anchor)

    anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    )
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-external-open-status]'),
      ).not.toBeNull()
    })

    uninstall()
    expect(document.querySelector('[data-external-open-status]')).toBeNull()
    expect(anchor).not.toHaveAttribute('aria-describedby')
    expect(anchor).not.toHaveAttribute('title')
  })
})
