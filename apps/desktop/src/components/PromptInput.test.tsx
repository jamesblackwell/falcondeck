import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
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

  it('orders the toggle row capability first, then the combined model menu', () => {
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
      .toEqual(['Agent', 'Permission mode', 'Sandbox mode'])
    // Model, effort, and fast mode share one popover chip at the end of the row.
    expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument()
  })

  it('shows model and effort together on the model menu chip', () => {
    render(
      <PromptInput
        {...promptInputProps}
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
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Model' })
    expect(trigger).toHaveTextContent('gpt-5.4')
    expect(trigger).toHaveTextContent('Medium')

    fireEvent.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: 'gpt-5.4' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    const effort = screen.getByRole('radio', { name: 'Medium' })
    expect(effort).toHaveAttribute('aria-checked', 'true')
  })

  describe('fast mode toggle', () => {
    const fastModel = {
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6-Sol',
      is_default: true,
      default_reasoning_effort: 'medium',
      supported_reasoning_efforts: [],
      service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
      default_service_tier: null,
    }
    const plainModel = {
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6-Luna',
      is_default: false,
      default_reasoning_effort: 'medium',
      supported_reasoning_efforts: [],
    }

    function openModelMenu() {
      fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    }

    it('stays hidden while no model of the provider advertises a tier', () => {
      render(
        <PromptInput
          {...promptInputProps}
          models={[plainModel]}
          selectedModelId={plainModel.id}
          onServiceTierChange={noop}
        />,
      )
      openModelMenu()
      expect(screen.queryByRole('menuitemcheckbox', { name: 'Fast mode' })).not.toBeInTheDocument()
    })

    it('greys out for a model without a tier instead of unmounting', () => {
      render(
        <PromptInput
          {...promptInputProps}
          models={[fastModel, plainModel]}
          selectedModelId={plainModel.id}
          onServiceTierChange={noop}
        />,
      )
      openModelMenu()
      expect(screen.getByRole('menuitemcheckbox', { name: 'Fast mode' })).toBeDisabled()
    })

    it('reports the advertised tier id on toggle and null on toggle-off', () => {
      const onServiceTierChange = vi.fn()
      const { rerender } = render(
        <PromptInput
          {...promptInputProps}
          models={[fastModel]}
          selectedModelId={fastModel.id}
          selectedServiceTier={null}
          onServiceTierChange={onServiceTierChange}
        />,
      )

      openModelMenu()
      const toggle = screen.getByRole('menuitemcheckbox', { name: 'Fast mode' })
      expect(toggle).toHaveAttribute('aria-checked', 'false')
      fireEvent.click(toggle)
      expect(onServiceTierChange).toHaveBeenLastCalledWith('priority')

      rerender(
        <PromptInput
          {...promptInputProps}
          models={[fastModel]}
          selectedModelId={fastModel.id}
          selectedServiceTier="priority"
          onServiceTierChange={onServiceTierChange}
        />,
      )
      expect(toggle).toHaveAttribute('aria-checked', 'true')
      // The chip advertises the active tier with a filled bolt while the menu is open or closed.
      fireEvent.click(toggle)
      expect(onServiceTierChange).toHaveBeenLastCalledWith(null)
    })
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
