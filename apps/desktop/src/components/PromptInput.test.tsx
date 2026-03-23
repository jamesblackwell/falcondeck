import React from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PromptInput } from '@falcondeck/chat-ui'

const noop = vi.fn()

const promptInputProps = {
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
  collaborationModes: [],
  selectedCollaborationModeId: null,
  onCollaborationModeChange: noop,
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
        value={'Line one\nLine two\nLine three'}
        {...promptInputProps}
      />,
    )

    const textarea = screen.getByPlaceholderText('Ask your coding agent anything...') as HTMLTextAreaElement
    expect(textarea.style.height).toBe('180px')

    mockScrollHeight = 52

    rerender(
      <PromptInput
        value=""
        {...promptInputProps}
      />,
    )

    expect(textarea.style.height).toBe('52px')
  })
})
