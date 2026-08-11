import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteErrorBoundary } from './RemoteErrorBoundary'

function Boom(): never {
  throw new Error('kaboom')
}

beforeEach(() => {
  // React logs the caught error; the boundary is what is under test.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('RemoteErrorBoundary', () => {
  it('renders children while nothing is wrong', () => {
    render(
      <RemoteErrorBoundary>
        <p>transcript</p>
      </RemoteErrorBoundary>,
    )
    expect(screen.getByText('transcript')).toBeInTheDocument()
  })

  it('shows a recovery screen with the failure message', () => {
    render(
      <RemoteErrorBoundary>
        <Boom />
      </RemoteErrorBoundary>,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('FalconDeck Remote stopped')
    expect(alert).toHaveTextContent('kaboom')
    expect(alert.closest('.fd-safe-area-padded')).toBeInTheDocument()
  })

  it('clears every stored key before reloading from the escape hatch', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })
    window.localStorage.setItem('falcondeck.remote.session.v1', '{}')
    window.localStorage.setItem('falcondeck.remote.selection.v1', '{}')
    window.localStorage.setItem('falcondeck.remote.client-keypair.v1', 'key')

    render(
      <RemoteErrorBoundary>
        <Boom />
      </RemoteErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: /clear saved state/i }))

    expect(window.localStorage.getItem('falcondeck.remote.session.v1')).toBeNull()
    expect(window.localStorage.getItem('falcondeck.remote.selection.v1')).toBeNull()
    expect(window.localStorage.getItem('falcondeck.remote.client-keypair.v1')).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
