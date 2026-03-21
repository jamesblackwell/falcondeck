import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderComponent, cleanup, textOf } from '../../test/render'
import { ApprovalBanner } from './ApprovalBanner'
import { ChatInput } from './ChatInput'
import { CodeBlock } from './CodeBlock'
import { SessionListItem } from './SessionListItem'
import { approval, thread } from '../../test/factories'

afterEach(cleanup)

describe('ApprovalBanner component', () => {
  it('renders with all fields', () => {
    const r = renderComponent(<ApprovalBanner approval={approval()} onAllow={vi.fn()} onDeny={vi.fn()} />)
    expect(textOf(r)).toContain('Run command')
  })

  it('renders with null command', () => {
    const r = renderComponent(<ApprovalBanner approval={approval({ command: null })} onAllow={vi.fn()} onDeny={vi.fn()} />)
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with null detail', () => {
    const r = renderComponent(<ApprovalBanner approval={approval({ detail: null })} onAllow={vi.fn()} onDeny={vi.fn()} />)
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with both null', () => {
    const r = renderComponent(<ApprovalBanner approval={approval({ command: null, detail: null })} onAllow={vi.fn()} onDeny={vi.fn()} />)
    expect(r.toJSON()).toBeTruthy()
  })
})

describe('ChatInput component', () => {
  const chatInputDefaults = {
    onChangeText: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    models: [],
    selectedModel: null,
    selectedEffort: 'medium',
    onSelectModel: vi.fn(),
    onSelectEffort: vi.fn(),
  }

  it('renders empty', () => {
    const r = renderComponent(<ChatInput value="" {...chatInputDefaults} />)
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with text', () => {
    const r = renderComponent(<ChatInput value="Hello" {...chatInputDefaults} />)
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders disabled', () => {
    const r = renderComponent(<ChatInput value="" {...chatInputDefaults} disabled />)
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with custom placeholder', () => {
    const r = renderComponent(<ChatInput value="" {...chatInputDefaults} placeholder="Custom..." />)
    expect(r.toJSON()).toBeTruthy()
  })
})

describe('CodeBlock component', () => {
  it('renders with language', () => {
    const r = renderComponent(<CodeBlock code="const x = 1" language="ts" />)
    expect(r.toJSON()).toBeTruthy()
    expect(textOf(r)).toContain('Copy')
  })

  it('renders without language', () => {
    const r = renderComponent(<CodeBlock code="plain" />)
    expect(r.toJSON()).toBeTruthy()
    expect(textOf(r)).toContain('Copy')
  })

  it('renders empty code', () => {
    const r = renderComponent(<CodeBlock code="" />)
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders diff with colored lines', () => {
    const r = renderComponent(<CodeBlock code={'+added\n-removed\n context'} language="diff" />)
    expect(r.toJSON()).toBeTruthy()
  })
})

describe('SessionListItem component', () => {
  it('renders unselected', () => {
    const r = renderComponent(
      <SessionListItem thread={thread({ id: 't1', title: 'Test' })} workspaceId="w1" isSelected={false} onSelectThread={vi.fn()} />,
    )
    expect(textOf(r)).toContain('Test')
  })

  it('renders selected', () => {
    const r = renderComponent(
      <SessionListItem thread={thread({ id: 't1', title: 'Test' })} workspaceId="w1" isSelected={true} onSelectThread={vi.fn()} />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders running', () => {
    const r = renderComponent(
      <SessionListItem thread={thread({ id: 't1', title: 'Running', status: 'running' })} workspaceId="w1" isSelected={false} onSelectThread={vi.fn()} />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with old date (days ago)', () => {
    const oldDate = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const r = renderComponent(
      <SessionListItem thread={thread({ id: 't1', title: 'Old', updated_at: oldDate })} workspaceId="w1" isSelected={false} onSelectThread={vi.fn()} />,
    )
    expect(textOf(r)).toContain('3d')
  })

  it('renders with hours-ago date', () => {
    const hoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString()
    const r = renderComponent(
      <SessionListItem thread={thread({ id: 't1', title: 'Hours', updated_at: hoursAgo })} workspaceId="w1" isSelected={false} onSelectThread={vi.fn()} />,
    )
    expect(textOf(r)).toContain('5h')
  })
})
