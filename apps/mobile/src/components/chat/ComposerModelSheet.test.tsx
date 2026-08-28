import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelSummary, ProviderOption } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '@/test/render'

import { ComposerModelSheet, agentModelChipLabel } from './ComposerModelSheet'

afterEach(cleanup)

const models: ModelSummary[] = [
  {
    id: 'gpt-5',
    label: 'GPT-5',
    is_default: true,
    default_reasoning_effort: 'medium',
    supported_reasoning_efforts: [],
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 Mini',
    is_default: false,
    default_reasoning_effort: 'medium',
    supported_reasoning_efforts: [],
  },
]

const providers: ProviderOption[] = [
  { provider: 'codex', label: 'Codex' },
  { provider: 'claude', label: 'Claude' },
  { provider: 'grok', label: 'Grok' },
]

function renderSheet(
  overrides: Partial<React.ComponentProps<typeof ComposerModelSheet>> = {},
) {
  const props: React.ComponentProps<typeof ComposerModelSheet> = {
    models,
    selectedModel: 'gpt-5',
    onSelectModel: vi.fn(),
    selectedProvider: 'codex',
    providers,
    showProviderSelector: true,
    onSelectProvider: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return { renderer: renderComponent(<ComposerModelSheet {...props} />), props }
}

describe('agentModelChipLabel', () => {
  it('joins the agent and model, and drops the separator when there is no model', () => {
    expect(agentModelChipLabel('Codex', 'gpt-5')).toBe('Codex · gpt-5')
    expect(agentModelChipLabel('Codex', null)).toBe('Codex')
  })
})

describe('ComposerModelSheet', () => {
  it('opens a new-thread picker on agents, then drills into models', () => {
    const { renderer, props } = renderSheet()

    expect(textOf(renderer)).toContain('Agent')
    expect(textOf(renderer)).toContain('Codex')
    expect(textOf(renderer)).toContain('Claude')
    expect(textOf(renderer)).toContain('Grok')
    expect(textOf(renderer)).not.toContain('gpt-5')
    expect(textOf(renderer)).not.toContain('Continue in another harness')

    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Claude' }).props.onPress()
    })
    expect(props.onSelectProvider).toHaveBeenCalledWith('claude')
    expect(props.onClose).not.toHaveBeenCalled()
    expect(textOf(renderer)).toContain('Model')
    expect(textOf(renderer)).toContain('gpt-5')
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Claude' }),
    ).toHaveLength(0)
  })

  it('advances from the current agent without re-firing it', () => {
    const { renderer, props } = renderSheet()
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Codex' }).props.onPress()
    })
    expect(props.onSelectProvider).not.toHaveBeenCalled()
    expect(textOf(renderer)).toContain('Model')
    expect(textOf(renderer)).toContain('gpt-5')
  })

  it('returns to agents from the model list', () => {
    const { renderer } = renderSheet()
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Codex' }).props.onPress()
    })
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Back to agents' })
        .props.onPress()
    })
    expect(textOf(renderer)).toContain('Claude')
    expect(textOf(renderer)).not.toContain('gpt-5')
  })

  it('closes after picking a model', () => {
    const { renderer, props } = renderSheet()
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Codex' }).props.onPress()
    })
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'gpt-5 mini' })
        .props.onPress()
    })
    expect(props.onSelectModel).toHaveBeenCalledWith('gpt-5-mini')
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('offers Default as clearing the explicit model pick', () => {
    const { renderer, props } = renderSheet()
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Codex' }).props.onPress()
    })
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Default' }).props.onPress()
    })
    expect(props.onSelectModel).toHaveBeenCalledWith(null)
  })

  it('skips the agent list when the workspace only has one provider', () => {
    const { renderer } = renderSheet({
      providers: [{ provider: 'codex', label: 'Codex' }],
    })
    expect(textOf(renderer)).toContain('Model')
    expect(textOf(renderer)).toContain('gpt-5')
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Codex' }),
    ).toHaveLength(0)
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Back to agents' }),
    ).toHaveLength(0)
  })

  it('opens an existing-thread picker on models, not agents', () => {
    const { renderer } = renderSheet({
      showProviderSelector: false,
      handoffProviders: [{ provider: 'claude', label: 'Claude' }],
      onHandoffProviderSelect: vi.fn(),
    })

    expect(textOf(renderer)).toContain('Model')
    expect(textOf(renderer)).toContain('gpt-5')
    expect(textOf(renderer)).not.toContain('Grok')
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Codex' }),
    ).toHaveLength(0)
  })

  it('offers handoff destinations behind the model list on an existing thread', () => {
    const onHandoffProviderSelect = vi.fn()
    const { renderer, props } = renderSheet({
      showProviderSelector: false,
      handoffProviders: [
        { provider: 'claude', label: 'Claude' },
        { provider: 'grok', label: 'Grok' },
      ],
      onHandoffProviderSelect,
    })

    expect(textOf(renderer)).toContain('Continue in another harness…')
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Continue in another harness…' })
        .props.onPress()
    })
    expect(textOf(renderer)).toContain('Continue in another harness')
    expect(textOf(renderer)).toContain('Claude')
    expect(textOf(renderer)).toContain('Grok')
    expect(textOf(renderer)).toContain(
      'Creates a linked thread; this one stays unchanged',
    )

    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Claude' }).props.onPress()
    })
    expect(onHandoffProviderSelect).toHaveBeenCalledWith('claude')
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onSelectProvider).not.toHaveBeenCalled()
  })

  it('keeps the handoff entry visible and inert while blocked', () => {
    const onHandoffProviderSelect = vi.fn()
    const { renderer } = renderSheet({
      showProviderSelector: false,
      handoffProviders: [{ provider: 'claude', label: 'Claude' }],
      onHandoffProviderSelect,
      handoffDisabledReason: 'Creating the linked handoff thread…',
    })

    const row = renderer.root.findByProps({
      accessibilityLabel: 'Continue in another harness…',
    })
    expect(row.props.accessibilityState.disabled).toBe(true)
    expect(textOf(renderer)).toContain(
      'Creating the linked handoff thread…',
    )
    act(() => {
      row.props.onPress()
    })
    expect(onHandoffProviderSelect).not.toHaveBeenCalled()
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Claude' }),
    ).toHaveLength(0)
  })

  it('does not offer handoff on a new-thread picker', () => {
    const { renderer } = renderSheet({
      showProviderSelector: true,
      handoffProviders: [{ provider: 'claude', label: 'Claude' }],
      onHandoffProviderSelect: vi.fn(),
    })
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Codex' }).props.onPress()
    })
    expect(textOf(renderer)).not.toContain('Continue in another harness')
  })

  it('still offers handoff while the model catalog is hydrating', () => {
    const onHandoffProviderSelect = vi.fn()
    const { renderer } = renderSheet({
      showProviderSelector: false,
      models: [],
      modelsLoading: true,
      selectedModel: null,
      handoffProviders: [{ provider: 'claude', label: 'Claude' }],
      onHandoffProviderSelect,
    })

    expect(textOf(renderer)).toContain('Continue in another harness…')
    expect(textOf(renderer)).toContain('Loading models…')
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Continue in another harness…' })
        .props.onPress()
    })
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Claude' }).props.onPress()
    })
    expect(onHandoffProviderSelect).toHaveBeenCalledWith('claude')
  })

  it('shows a loading placeholder while the catalog is empty', () => {
    const { renderer } = renderSheet({
      models: [],
      modelsLoading: true,
      selectedModel: null,
    })
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Codex' }).props.onPress()
    })
    expect(textOf(renderer)).toContain('Loading models…')
  })
})
