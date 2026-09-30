import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_TITLE_SUGGESTION_MODEL, normalizePreferences } from '@falcondeck/client-core'

import { TitleSuggestionModelCard } from './TitleSuggestionModelCard'

describe('TitleSuggestionModelCard', () => {
  it('shows Luna by default and saves a custom OpenRouter model', () => {
    const onUpdatePreferences = vi.fn()
    render(
      <TitleSuggestionModelCard
        preferences={normalizePreferences({})}
        onUpdatePreferences={onUpdatePreferences}
      />,
    )

    const input = screen.getByRole('combobox', { name: 'Rename suggestion model' })
    expect(input).toHaveValue(DEFAULT_TITLE_SUGGESTION_MODEL)
    fireEvent.change(input, { target: { value: 'openai/gpt-5.6-luna' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }))
    expect(onUpdatePreferences).toHaveBeenCalledWith({
      title_suggestion_model: 'openai/gpt-5.6-luna',
    })
  })

  it('resets the saved model to Luna', () => {
    const onUpdatePreferences = vi.fn()
    render(
      <TitleSuggestionModelCard
        preferences={normalizePreferences({ title_suggestion_model: 'openai/gpt-5.6-luna' })}
        onUpdatePreferences={onUpdatePreferences}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onUpdatePreferences).toHaveBeenCalledWith({
      title_suggestion_model: DEFAULT_TITLE_SUGGESTION_MODEL,
    })
  })
})
