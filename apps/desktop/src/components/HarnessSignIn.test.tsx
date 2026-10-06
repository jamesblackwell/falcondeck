import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { normalizeHarnessSummary } from '@falcondeck/client-core'
import { HarnessSignIn } from './HarnessSignIn'

const codex = normalizeHarnessSummary({ id: 'codex', label: 'Codex', bin: 'codex', installed: true, resolved_path: "/Users/QA's account/.local/bin/codex", auth_verdict: 'unauthenticated' })!

describe('HarnessSignIn', () => {
  it('copies the resolved CLI command and checks sign-in explicitly', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const onCheck = vi.fn()
    render(<HarnessSignIn harness={codex} hostLabel="this Mac" busy={false} onCheck={onCheck} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in command' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
    expect(writeText).toHaveBeenCalledWith("'/Users/QA'\\''s account/.local/bin/codex' login")
    fireEvent.click(screen.getByRole('button', { name: 'Check sign-in' }))
    expect(onCheck).toHaveBeenCalledOnce()
  })

  it('offers repair before sign-in for a broken launcher', () => {
    render(<HarnessSignIn harness={{ ...codex, install_state: 'broken' }} hostLabel="this Mac" busy={false} onCheck={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Copy sign-in command' })).toBeNull()
  })

  it('shows a manual fallback when clipboard access fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    render(<HarnessSignIn harness={codex} hostLabel="this Mac" busy={false} onCheck={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in command' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Select and copy the command above.')
  })

  it('removes sign-in instructions once authenticated', () => {
    render(<HarnessSignIn harness={{ ...codex, auth_verdict: 'authenticated' }} hostLabel="this Mac" busy={false} onCheck={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Check sign-in' })).toBeNull()
  })
})
