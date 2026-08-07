import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyButton } from '@falcondeck/ui'

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('CopyButton', () => {
  it('confirms only once the clipboard write has actually resolved', async () => {
    let resolveWrite: (() => void) | null = null
    stubClipboard(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve
        }),
    )

    render(<CopyButton text="pairing-code" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    // Still pending: claiming success here is what made users paste nothing.
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument()

    resolveWrite?.()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    })
  })

  it('reports a failed clipboard write instead of claiming success', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')))

    render(<CopyButton text="pairing-code" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument()
    })
  })

  it('survives a webview with no clipboard API at all', async () => {
    const onError = vi.fn()
    window.addEventListener('unhandledrejection', onError)

    render(<CopyButton text="pairing-code" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument()
    })
    window.removeEventListener('unhandledrejection', onError)
  })
})
