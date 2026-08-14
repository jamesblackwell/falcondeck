import React from 'react'
import { TextInput as NativeTextInput } from 'react-native'
import { act } from 'react-test-renderer'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderComponent, cleanup, renderPure, textOf } from '../../test/render'
import { Text } from './Text'
import { Button } from './Button'
import { Badge } from './Badge'
import { Card, CardHeader, CardContent } from './Card'
import { Input } from './Input'
import { Skeleton } from './Skeleton'
import { EmptyState } from './EmptyState'
import { StatusIndicator } from './StatusIndicator'
import { SegmentedControl } from './SegmentedControl'
import { OptionSheet } from './OptionSheet'

afterEach(cleanup)

describe('Text', () => {
  it('renders body variant', () => { expect(renderPure(Text, { children: 'Hello' })).toBeTruthy() })
  it('renders all variants', () => {
    for (const v of ['body', 'supporting', 'label', 'meta', 'microlabel', 'caption', 'heading', 'mono'] as const)
      expect(renderPure(Text, { variant: v, children: v })).toBeTruthy()
  })
  it('renders all colors', () => {
    for (const c of ['primary', 'secondary', 'tertiary', 'muted', 'faint', 'accent', 'danger', 'warning', 'success', 'info'] as const)
      expect(renderPure(Text, { color: c, children: c })).toBeTruthy()
  })
  it('renders all sizes', () => {
    for (const s of ['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl'] as const)
      expect(renderPure(Text, { size: s, children: s })).toBeTruthy()
  })
  it('renders all weights', () => {
    for (const w of ['normal', 'medium', 'semibold', 'bold'] as const)
      expect(renderPure(Text, { weight: w, children: w })).toBeTruthy()
  })
  it('renders minimal', () => { expect(renderPure(Text, { children: 'Min' })).toBeTruthy() })
  it('derives line height from the requested text size', () => {
    const caption = renderComponent(<Text variant="caption">Caption</Text>)
    const captionNode = caption.root.findByType('Text' as never)
    expect(captionNode.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ fontSize: 12, lineHeight: 18 })]),
    )

    const large = renderComponent(<Text size="lg">Large</Text>)
    const largeNode = large.root.findByType('Text' as never)
    expect(largeNode.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ fontSize: 19, lineHeight: 28.5 })]),
    )
  })
  it('applies semantic emphasis unless the caller overrides it', () => {
    const meta = renderComponent(<Text variant="meta">Metadata</Text>)
    const metaNode = meta.root.findByType('Text' as never)
    expect(metaNode.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ color: '#666', fontSize: 12 })]),
    )

    const overridden = renderComponent(<Text variant="meta" color="danger">Error</Text>)
    const overriddenNode = overridden.root.findByType('Text' as never)
    expect(overriddenNode.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ color: '#f00' })]),
    )
  })
})

describe('Badge', () => {
  it('renders all variants', () => {
    for (const v of ['default', 'success', 'warning', 'danger', 'info'] as const)
      expect(renderPure(Badge, { variant: v, children: v })).toBeTruthy()
  })
  it('renders with dot', () => { expect(renderPure(Badge, { dot: true, children: 'D' })).toBeTruthy() })
  it('renders without dot', () => { expect(renderPure(Badge, { children: 'N' })).toBeTruthy() })
})

describe('Card', () => {
  it('renders all variants', () => {
    for (const v of ['elevated', 'flat', 'ghost'] as const)
      expect(renderPure(Card, { variant: v, children: 'C' })).toBeTruthy()
  })
  it('renders default', () => { expect(renderPure(Card, { children: 'D' })).toBeTruthy() })
  it('renders styled', () => { expect(renderPure(Card, { style: { margin: 10 }, children: 'S' })).toBeTruthy() })
})

describe('CardHeader', () => {
  it('renders', () => { expect(renderPure(CardHeader, { children: 'H' })).toBeTruthy() })
})

describe('CardContent', () => {
  it('renders', () => { expect(renderPure(CardContent, { children: 'C' })).toBeTruthy() })
})

describe('Input', () => {
  it('renders basic', () => { expect(renderComponent(<Input value="test" onChangeText={() => {}} />).toJSON()).toBeTruthy() })
  it('renders with error styling', () => { expect(renderComponent(<Input error value="" />).toJSON()).toBeTruthy() })
  it('renders without error', () => { expect(renderComponent(<Input value="plain" />).toJSON()).toBeTruthy() })
  it('renders with placeholder', () => { expect(renderComponent(<Input value="" placeholder="Type..." />).toJSON()).toBeTruthy() })
  it('keeps focus styling active while forwarding caller focus callbacks', () => {
    const onFocus = vi.fn()
    const onBlur = vi.fn()
    const renderer = renderComponent(<Input value="" onFocus={onFocus} onBlur={onBlur} />)
    const input = renderer.root.findByType(NativeTextInput)

    act(() => input.props.onFocus({ nativeEvent: {} }))
    expect(onFocus).toHaveBeenCalledOnce()
    expect(input.props.style[1]).toEqual(expect.objectContaining({ borderColor: expect.anything() }))

    act(() => input.props.onBlur({ nativeEvent: {} }))
    expect(onBlur).toHaveBeenCalledOnce()
    expect(input.props.style[1]).toBeUndefined()
  })
})

describe('Skeleton', () => {
  it('renders defaults', () => { expect(renderComponent(<Skeleton />).toJSON()).toBeTruthy() })
  it('renders custom', () => { expect(renderComponent(<Skeleton width={200} height={24} radius={12} />).toJSON()).toBeTruthy() })
})

describe('EmptyState', () => {
  it('renders title only', () => { expect(renderPure(EmptyState, { title: 'Empty' })).toBeTruthy() })
  it('renders with description', () => { expect(renderPure(EmptyState, { title: 'E', description: 'D' })).toBeTruthy() })
  it('renders with action', () => { expect(renderPure(EmptyState, { title: 'E', actionLabel: 'A', onAction: () => {} })).toBeTruthy() })
  it('renders with icon', () => { expect(renderPure(EmptyState, { title: 'E', icon: 'I' })).toBeTruthy() })
  it('renders minimal', () => { expect(renderPure(EmptyState, { title: 'T' })).toBeTruthy() })
})

describe('StatusIndicator', () => {
  it('renders all statuses', () => {
    for (const s of ['connected', 'connecting', 'disconnected', 'error', 'idle', 'active'] as const)
      expect(renderComponent(<StatusIndicator status={s} />).toJSON()).toBeTruthy()
  })
  it('sm size', () => { expect(renderComponent(<StatusIndicator status="connected" size="sm" />).toJSON()).toBeTruthy() })
  it('md size', () => { expect(renderComponent(<StatusIndicator status="active" size="md" />).toJSON()).toBeTruthy() })
  it('pulse on', () => { expect(renderComponent(<StatusIndicator status="connected" pulse />).toJSON()).toBeTruthy() })
  it('pulse off', () => { expect(renderComponent(<StatusIndicator status="idle" pulse={false} />).toJSON()).toBeTruthy() })
})

describe('Button', () => {
  it('renders all variants', () => {
    for (const v of ['default', 'secondary', 'outline', 'ghost', 'danger'] as const)
      expect(renderComponent(<Button variant={v} label={v} />).toJSON()).toBeTruthy()
  })
  it('renders all sizes', () => {
    for (const s of ['default', 'sm', 'lg', 'icon'] as const)
      expect(renderComponent(<Button size={s} label="b" />).toJSON()).toBeTruthy()
  })
  it('renders with icon', () => { expect(renderComponent(<Button icon={<span />} label="Click" />).toJSON()).toBeTruthy() })
  it('renders loading', () => { expect(renderComponent(<Button loading label="L" />).toJSON()).toBeTruthy() })
  it('renders disabled', () => { expect(renderComponent(<Button disabled label="D" />).toJSON()).toBeTruthy() })
  it('renders children', () => { expect(renderComponent(<Button>Child</Button>).toJSON()).toBeTruthy() })
  it('renders danger loading', () => { expect(renderComponent(<Button variant="danger" loading />).toJSON()).toBeTruthy() })
})

describe('SegmentedControl', () => {
  it('renders accessible 44pt radio options and changes selection', () => {
    const onChange = vi.fn()
    const renderer = renderComponent(
      <SegmentedControl
        label="Theme"
        options={[
          { value: 'system', label: 'System' },
          { value: 'dark', label: 'Dark' },
        ]}
        selectedValue="system"
        onChange={onChange}
      />,
    )
    const options = renderer.root.findAllByType('Pressable' as never)

    expect(options).toHaveLength(2)
    expect(options[0]?.props.accessibilityRole).toBe('radio')
    expect(options[0]?.props.accessibilityState).toEqual({ selected: true })
    expect(options[1]?.props.accessibilityState).toEqual({ selected: false })
    expect(options[0]?.props.style({ pressed: false })).toEqual(
      expect.arrayContaining([expect.objectContaining({ minHeight: 44 })]),
    )

    act(() => options[1]?.props.onPress())
    expect(onChange).toHaveBeenCalledWith('dark')
  })
})

describe('OptionSheet', () => {
  it('adds a search filter only for long option lists', () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      value: `model-${index}`,
      label: index === 8 ? 'Kimi K2.6' : `Example Model ${index}`,
      description: index === 8 ? 'Moonshot AI' : 'Example provider',
    }))
    const renderer = renderComponent(
      <OptionSheet
        title="Model"
        items={items}
        selected={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const search = renderer.root.findByProps({ accessibilityLabel: 'Search model' })
    expect(search.props.accessibilityHint).toBe('9 options')
    act(() => search.props.onChangeText('moonshot kimi'))

    expect(textOf(renderer)).toContain('Kimi K2.6')
    expect(textOf(renderer)).not.toContain('Example Model 1')
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Search model' }).props
        .accessibilityHint,
    ).toBe('1 option')
  })

  it('shows an accessible empty result and keeps short lists quiet', () => {
    const longRenderer = renderComponent(
      <OptionSheet
        title="Model"
        items={Array.from({ length: 8 }, (_, index) => ({
          value: `${index}`,
          label: `Model ${index}`,
        }))}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    act(() =>
      longRenderer.root
        .findByProps({ accessibilityLabel: 'Search model' })
        .props.onChangeText('missing'),
    )
    expect(textOf(longRenderer)).toContain('No options match “missing”')

    const shortRenderer = renderComponent(
      <OptionSheet
        title="Agent"
        items={[{ value: 'codex', label: 'Codex' }]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      shortRenderer.root.findAllByProps({ accessibilityLabel: 'Search agent' }),
    ).toHaveLength(0)
  })
})
