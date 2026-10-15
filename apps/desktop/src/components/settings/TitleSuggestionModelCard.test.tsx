import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_TITLE_SUGGESTION_MODEL, DEFAULT_TITLE_SUGGESTION_PROMPT, normalizePreferences } from '@falcondeck/client-core'

import { TitleSuggestionModelCard } from './TitleSuggestionModelCard'

describe('TitleSuggestionModelCard', () => {
  it('saves title style instructions independently of the model', () => {
    const onUpdatePreferences = vi.fn()
    render(
      <TitleSuggestionModelCard
        preferences={normalizePreferences({})}
        onUpdatePreferences={onUpdatePreferences}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Title prompt' })
    expect(input).toHaveValue(DEFAULT_TITLE_SUGGESTION_PROMPT)
    expect(screen.getByRole('button', { name: 'Save prompt' })).toBeDisabled()
    fireEvent.change(input, { target: { value: ' Use 2–3 words in ALL CAPS. ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }))
    expect(onUpdatePreferences).toHaveBeenCalledWith({
      title_suggestion_prompt: 'Use 2–3 words in ALL CAPS.',
    })
  })

  it('reflects saved preferences and restores the default prompt', () => {
    const onUpdatePreferences = vi.fn()
    const { rerender } = render(
      <TitleSuggestionModelCard
        preferences={normalizePreferences({})}
        onUpdatePreferences={onUpdatePreferences}
      />,
    )
    rerender(
      <TitleSuggestionModelCard
        preferences={normalizePreferences({ title_suggestion_prompt: 'Use ALL CAPS.' })}
        onUpdatePreferences={onUpdatePreferences}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Title prompt' })
    expect(input).toHaveValue('Use ALL CAPS.')
    fireEvent.change(input, { target: { value: ' \n ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }))
    expect(onUpdatePreferences).toHaveBeenLastCalledWith({
      title_suggestion_prompt: DEFAULT_TITLE_SUGGESTION_PROMPT,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset prompt' }))
    expect(input).toHaveValue(DEFAULT_TITLE_SUGGESTION_PROMPT)
    expect(onUpdatePreferences).toHaveBeenLastCalledWith({
      title_suggestion_prompt: DEFAULT_TITLE_SUGGESTION_PROMPT,
    })
  })
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
    fireEvent.click(screen.getByRole('button', { name: 'Reset model' }))
    expect(onUpdatePreferences).toHaveBeenCalledWith({
      title_suggestion_model: DEFAULT_TITLE_SUGGESTION_MODEL,
    })
  })
})
