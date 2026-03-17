import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { renderComponent, cleanup, renderPure, textOf } from '../../test/render'
import { Text } from './Text'
import { Button } from './Button'
import { Badge } from './Badge'
import { Card, CardHeader, CardContent } from './Card'
import { Input } from './Input'
import { Skeleton } from './Skeleton'
import { EmptyState } from './EmptyState'
import { StatusIndicator } from './StatusIndicator'

afterEach(cleanup)

describe('Text', () => {
  it('renders body variant', () => { expect(renderPure(Text, { children: 'Hello' })).toBeTruthy() })
  it('renders all variants', () => {
    for (const v of ['body', 'label', 'caption', 'heading', 'mono'] as const)
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
