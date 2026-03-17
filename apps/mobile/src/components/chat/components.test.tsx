import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderComponent, renderPure, cleanup, textOf } from '../../test/render'
import { ApprovalBanner } from './ApprovalBanner'
import { ChatInput } from './ChatInput'
import { CodeBlock } from './CodeBlock'
import { SessionListItem } from './SessionListItem'
import { approval } from '../../test/factories'

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
  it('renders empty', () => {
    const r = renderComponent(<ChatInput value="" onChangeText={vi.fn()} onSubmit={vi.fn()} />)
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with text', () => {
    const r = renderComponent(<ChatInput value="Hello" onChangeText={vi.fn()} onSubmit={vi.fn()} />)
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders disabled', () => {
    const r = renderComponent(<ChatInput value="" onChangeText={vi.fn()} onSubmit={vi.fn()} disabled />)
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with custom placeholder', () => {
    const r = renderComponent(<ChatInput value="" onChangeText={vi.fn()} onSubmit={vi.fn()} placeholder="Custom..." />)
    expect(r.toJSON()).toBeTruthy()
  })
})

describe('CodeBlock component', () => {
  it('renders with language', () => {
    const el = renderPure(CodeBlock, { code: 'const x = 1', language: 'ts' })
    expect(el).toBeTruthy()
  })

  it('renders without language', () => {
    const el = renderPure(CodeBlock, { code: 'plain' })
    expect(el).toBeTruthy()
  })

  it('renders empty code', () => {
    const el = renderPure(CodeBlock, { code: '' })
    expect(el).toBeTruthy()
  })
})

describe('SessionListItem component', () => {
  it('renders unselected', () => {
    const r = renderComponent(
      <SessionListItem threadId="t1" title="Test" isRunning={false} updatedAt={new Date().toISOString()} isSelected={false} onSelect={vi.fn()} />,
    )
    expect(textOf(r)).toContain('Test')
  })

  it('renders selected', () => {
    const r = renderComponent(
      <SessionListItem threadId="t1" title="Test" isRunning={false} updatedAt={new Date().toISOString()} isSelected={true} onSelect={vi.fn()} />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders running', () => {
    const r = renderComponent(
      <SessionListItem threadId="t1" title="Running" isRunning={true} updatedAt={new Date().toISOString()} isSelected={false} onSelect={vi.fn()} />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with old date (days ago)', () => {
    const oldDate = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const r = renderComponent(
      <SessionListItem threadId="t1" title="Old" isRunning={false} updatedAt={oldDate} isSelected={false} onSelect={vi.fn()} />,
    )
    expect(textOf(r)).toContain('3d')
  })

  it('renders with hours-ago date', () => {
    const hoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString()
    const r = renderComponent(
      <SessionListItem threadId="t1" title="Hours" isRunning={false} updatedAt={hoursAgo} isSelected={false} onSelect={vi.fn()} />,
    )
    expect(textOf(r)).toContain('5h')
  })
})
