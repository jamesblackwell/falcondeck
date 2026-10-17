import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelSummary } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '@/test/render'

import { InputToolbar } from './InputToolbar'

afterEach(cleanup)

const model: ModelSummary = {
  id: 'gpt-6.1-sol',
  label: 'GPT-6.1 Sol',
  is_default: true,
  default_reasoning_effort: 'medium',
  supported_reasoning_efforts: [],
  service_tiers: [
    { id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
    { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest responses, increased usage' },
  ],
}

function renderToolbar(overrides: Partial<React.ComponentProps<typeof InputToolbar>> = {}) {
  const props: React.ComponentProps<typeof InputToolbar> = {
    models: [model],
    selectedModel: null,
    selectedEffort: 'medium',
    effortOptions: [],
    selectedProvider: 'codex',
    showProviderSelector: false,
    onSelectModel: vi.fn(),
    onSelectEffort: vi.fn(),
    onSelectProvider: vi.fn(),
    onSelectServiceTier: vi.fn(),
    ...overrides,
  }
  return { renderer: renderComponent(<InputToolbar {...props} />), props }
}

describe('InputToolbar speed menu', () => {
  it('opens all advertised speeds without changing the selection, then selects Ultrafast', () => {
    const { renderer, props } = renderToolbar()
    const chip = renderer.root.findByProps({ accessibilityLabel: 'Speed' })
    expect(chip.props.accessibilityRole).toBe('button')
    expect(chip.props.accessibilityValue).toEqual({ text: 'Standard' })
    act(() => chip.props.onPress())
    expect(props.onSelectServiceTier).not.toHaveBeenCalled()
    expect(textOf(renderer)).toContain('Default speed')
    expect(textOf(renderer)).toContain('2x speed, increased usage')
    expect(renderer.root.findByProps({ accessibilityLabel: 'Standard' }).props.accessibilityState.selected).toBe(true)
    act(() => renderer.root.findByProps({ accessibilityLabel: 'Ultrafast' }).props.onPress())
    expect(props.onSelectServiceTier).toHaveBeenCalledWith('ultrafast')
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Close options' })).toHaveLength(0)
  })

  it('restores Ultrafast and sends null when Standard is selected', () => {
    const { renderer, props } = renderToolbar({ selectedServiceTier: 'ultrafast' })
    const chip = renderer.root.findByProps({ accessibilityLabel: 'Speed' })
    expect(chip.props.accessibilityValue).toEqual({ text: 'Ultrafast' })
    act(() => chip.props.onPress())
    expect(renderer.root.findByProps({ accessibilityLabel: 'Ultrafast' }).props.accessibilityState.selected).toBe(true)
    act(() => renderer.root.findByProps({ accessibilityLabel: 'Standard' }).props.onPress())
    expect(props.onSelectServiceTier).toHaveBeenCalledWith(null)
  })

  it('hides the picker for a model without tiers and blocks it while disabled', () => {
    const { renderer } = renderToolbar({ models: [{ ...model, service_tiers: [] }] })
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Speed' })).toHaveLength(0)
    const disabled = renderToolbar({ disabled: true })
    act(() => disabled.renderer.root.findByProps({ accessibilityLabel: 'Speed' }).props.onPress())
    expect(disabled.renderer.root.findAllByProps({ accessibilityLabel: 'Close options' })).toHaveLength(0)
    expect(disabled.props.onSelectServiceTier).not.toHaveBeenCalled()
  })
})
