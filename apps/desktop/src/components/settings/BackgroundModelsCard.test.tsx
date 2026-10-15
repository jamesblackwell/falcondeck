import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { normalizePreferences } from '@falcondeck/client-core'

import { BackgroundModelsCard } from './BackgroundModelsCard'

describe('BackgroundModelsCard', () => {
  it('shows the restored model in the input after Reset', () => {
    const custom = normalizePreferences({
      utility_models: {
        provider_order: ['claude', 'codex', 'opencode', 'grok'],
        models: [{ provider: 'claude', model_id: 'sonnet' }],
      },
    })
    const onUpdatePreferences = vi.fn()
    const { rerender } = render(
      <BackgroundModelsCard preferences={custom} onUpdatePreferences={onUpdatePreferences} />,
    )
    const input = () => screen.getByLabelText('Claude Code background model')
    expect(input()).toHaveValue('sonnet')

    fireEvent.click(screen.getByRole('button', { name: /Reset/ }))
    expect(onUpdatePreferences).toHaveBeenCalled()
    rerender(
      <BackgroundModelsCard
        preferences={normalizePreferences({})}
        onUpdatePreferences={onUpdatePreferences}
      />,
    )
    expect(input()).toHaveValue('haiku')
  })
})
