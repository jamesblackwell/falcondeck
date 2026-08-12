import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { InterruptedTurnNotice } from '@falcondeck/chat-ui'

describe('InterruptedTurnNotice', () => {
  it('explains that the conversation is safe and continues in one click', () => {
    const onContinue = vi.fn()
    render(<InterruptedTurnNotice onContinue={onContinue} />)

    expect(
      screen.getByText('This response stopped when FalconDeck closed'),
    ).toBeInTheDocument()
    expect(screen.getByText(/conversation is safe/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('disables repeat clicks while the continuation is starting', () => {
    render(<InterruptedTurnNotice onContinue={() => {}} isContinuing />)

    expect(screen.getByRole('button', { name: 'Continuing…' })).toBeDisabled()
  })
})
