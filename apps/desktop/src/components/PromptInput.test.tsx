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
    const providerTrigger = screen.getByRole('combobox', { name: 'Agent' })
    expect(providerTrigger).not.toBeDisabled()
    expect(providerTrigger).toHaveTextContent('Codex')
    expect(screen.getAllByRole('combobox')[0]).not.toBeDisabled()
  })

  it('shows Stop when a turn is running and the draft is empty', () => {
    const onStop = vi.fn()
    render(
      <PromptInput
        {...promptInputProps}
        value=""
        isRunning
        onStop={onStop}
        capabilities={{
          supports_review: false,
          supports_goals: false,
          supports_images: true,
          supports_skills: true,
          supports_interrupt: true,
          sandbox_modes: [],
          permission_modes: [],
        }}
      />,
    )

    const stopButton = screen.getByRole('button', { name: 'Stop generating' })
    expect(stopButton).toBeEnabled()
    stopButton.click()
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('greys the capability pickers instead of dropping them, so the row keeps its shape', () => {
    const capabilities = {
      supports_review: false,
      supports_goals: false,
      supports_images: true,
      supports_skills: true,
      supports_interrupt: true,
      sandbox_modes: [],
      permission_modes: [],
    }

    const { rerender } = render(
      <PromptInput
        {...promptInputProps}
        capabilities={capabilities}
        onPermissionModeChange={noop}
        onSandboxModeChange={noop}
      />,
    )

    // Present but inert: an agent without these modes must not make the
    // composer reflow when the user switches to it.
    expect(screen.getByRole('combobox', { name: 'Permission mode' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Sandbox mode' })).toBeDisabled()

    rerender(
      <PromptInput
        {...promptInputProps}
        capabilities={{
          ...capabilities,
          permission_modes: ['default', 'acceptEdits'],
          sandbox_modes: ['read-only'],
        }}
        onPermissionModeChange={noop}
        onSandboxModeChange={noop}
      />,
    )

    expect(screen.getByRole('combobox', { name: 'Permission mode' })).toBeEnabled()
    expect(screen.getByRole('combobox', { name: 'Sandbox mode' })).toBeEnabled()
  })

  it('orders the toggle row capability first, then model and effort', () => {
    render(
      <PromptInput
        {...promptInputProps}
        showProviderSelector
        capabilities={{
          supports_review: false,
          supports_goals: false,
          supports_images: true,
          supports_skills: true,
          supports_interrupt: true,
          sandbox_modes: ['read-only'],
          permission_modes: ['default'],
        }}
        onPermissionModeChange={noop}
        onSandboxModeChange={noop}
      />,
    )

    expect(screen.getAllByRole('combobox').map((element) => element.getAttribute('aria-label')))
      .toEqual(['Agent', 'Permission mode', 'Sandbox mode', 'Model', 'Reasoning effort'])
  })

  it('keeps Send when a turn is running but the draft has content', () => {
    render(
      <PromptInput
        {...promptInputProps}
        value="Follow up"
        isRunning
        onStop={vi.fn()}
        capabilities={{
          supports_review: false,
          supports_goals: false,
          supports_images: true,
          supports_skills: true,
          supports_interrupt: true,
          sandbox_modes: [],
          permission_modes: [],
        }}
      />,
    )

    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument()
  })
})
