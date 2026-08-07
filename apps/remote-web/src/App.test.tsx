import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
  document.title = ''
})

describe('App', () => {
  it('mounts on the pairing screen when nothing is stored', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'FalconDeck Remote' })).toBeInTheDocument()
    expect(screen.getByLabelText('Pairing code')).toHaveValue('')
  })

  it('prefills the code from a pairing link', () => {
    window.history.replaceState({}, '', '/?code=ABCD1234')
    render(<App />)
    expect(screen.getByLabelText('Pairing code')).toHaveValue('ABCD1234')
    window.history.replaceState({}, '', '/')
  })

  it('discards a stored session written by an older storage version', () => {
    window.localStorage.setItem(
      'falcondeck.remote.session.v1',
      JSON.stringify({ version: 0, sessionId: 'stale' }),
    )
    render(<App />)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(window.localStorage.getItem('falcondeck.remote.session.v1')).toBeNull()
  })
})
