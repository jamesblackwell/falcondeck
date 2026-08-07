import React from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PromptInput } from '@falcondeck/chat-ui'

const noop = vi.fn()

const promptInputProps = {
  value: '',
  onValueChange: noop,
  onSubmit: noop,
  onPickImages: noop,
  onRemoveAttachment: noop,
  attachments: [],
  skills: [],
  selectedProvider: 'codex' as const,
  onProviderChange: noop,
  providerLocked: false,
  showProviderSelector: false,
  models: [],
  selectedModelId: null,
  onModelChange: noop,
  reasoningOptions: ['low', 'medium', 'high'],
  selectedEffort: 'medium',
  onEffortChange: noop,
  disabled: false,
  sendDisabled: false,
}

describe('PromptInput', () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight')

  afterEach(() => {
    if (originalScrollHeight) {
      Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', originalScrollHeight)
      return
    }
    delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight
  })

  it('collapses back to the single-line height when the value is cleared externally', () => {
    let mockScrollHeight = 180

    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return mockScrollHeight
      },
    })

    const { rerender } = render(
      <PromptInput
        {...promptInputProps}
        value={'Line one\nLine two\nLine three'}
      />,
    )

    const textarea = screen.getByPlaceholderText('Ask anything') as HTMLTextAreaElement
    expect(textarea.style.height).toBe('180px')

    mockScrollHeight = 52

    rerender(
      <PromptInput
        {...promptInputProps}
        value=""
      />,
    )

    expect(textarea.style.height).toBe('52px')
  })

  it('keeps new-thread controls enabled when sending is blocked but the composer is otherwise available', () => {
    render(
      <PromptInput
        {...promptInputProps}
        value="Draft message"
        showProviderSelector
        models={[
          {
            id: 'gpt-5.4',
            label: 'gpt-5.4',
            is_default: true,
            default_reasoning_effort: null,
            supported_reasoning_efforts: [],
          },
        ]}
        selectedModelId="gpt-5.4"
        sendDisabled
      />,
    )

    expect(screen.getByPlaceholderText('Ask anything')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Codex' })).not.toBeDisabled()
    expect(screen.getAllByRole('combobox')[0]).not.toBeDisabled()
  })
})
