import React from 'react'
import { act } from 'react-test-renderer'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderComponent, cleanup, textOf } from '../../test/render'
import { ApprovalBanner, approvalDetail } from './ApprovalBanner'
import { ChatInput } from './ChatInput'
import { CodeBlock } from './CodeBlock'
import { SessionListItem } from './SessionListItem'
import { approval, thread } from '../../test/factories'

afterEach(cleanup)

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style)
  }
  return (style as Record<string, unknown>) ?? {}
}

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

  it('shows one queue position without rendering duplicated raw JSON', () => {
    const item = approval({
      detail: '{"command":"rm -rf node_modules","description":"Clean dependencies"}',
    })
    const r = renderComponent(
      <ApprovalBanner
        approval={item}
        pendingCount={3}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )

    expect(textOf(r)).toContain('1 of 3')
    expect(textOf(r)).toContain('Clean dependencies')
    expect(textOf(r)).not.toContain('{"command"')
  })

  it('drops a JSON detail that only repeats promoted fields', () => {
    expect(approvalDetail(approval({ detail: '{"command":"rm -rf node_modules"}' }))).toBeNull()
  })
})

describe('ChatInput component', () => {
  const chatInputDefaults = {
    onChangeText: vi.fn(),
    onSubmit: vi.fn(),
    onPickImages: vi.fn(),
    onRemoveAttachment: vi.fn(),
    attachments: [],
    skills: [],
    models: [],
    selectedModel: null,
    selectedEffort: 'medium',
    effortOptions: ['low', 'medium', 'high'],
    selectedProvider: 'codex' as const,
    showProviderSelector: false,
    onSelectModel: vi.fn(),
    onSelectEffort: vi.fn(),
    onSelectProvider: vi.fn(),
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

  it('moves thread setup controls into the plus menu', () => {
    const r = renderComponent(
      <ChatInput
        value=""
        {...chatInputDefaults}
        showProviderSelector
        providers={[{ provider: 'codex', label: 'Codex' }]}
      />,
    )

    const addButton = r.root
      .findAllByType('Pressable' as any)
      .find((button) => button.props.accessibilityLabel === 'Add to prompt')
    act(() => addButton?.props.onPress())

    expect(textOf(r)).toContain('Photos')
    expect(textOf(r)).toContain('Agent')
  })

  it('submits while the thread is running', () => {
    const onSubmit = vi.fn()
    const r = renderComponent(<ChatInput value="Steer the agent" {...chatInputDefaults} onSubmit={onSubmit} />)
    const buttons = r.root.findAllByType('Pressable' as any)
    const sendButton = buttons[buttons.length - 1]

    act(() => {
      sendButton?.props.onPress()
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('submits attachments without text', () => {
    const onSubmit = vi.fn()
    const r = renderComponent(
      <ChatInput
        value=""
        {...chatInputDefaults}
        attachments={[
          {
            type: 'image',
            id: 'img-1',
            name: 'diagram.png',
            mime_type: 'image/png',
            url: 'data:image/png;base64,abc',
          },
        ]}
        onSubmit={onSubmit}
      />,
    )
    const buttons = r.root.findAllByType('Pressable' as any)
    const sendButton = buttons[buttons.length - 1]

    expect(textOf(r)).toContain('diagram.png')

    act(() => {
      sendButton?.props.onPress()
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('shows slash skill suggestions', () => {
    const r = renderComponent(
      <ChatInput
        value="/lin"
        {...chatInputDefaults}
        skills={[
          {
            id: 'skill-1',
            label: 'Lint',
            alias: '/lint',
            availability: 'both',
            providers: ['codex', 'claude'],
            source_kind: 'project_file',
            description: 'Run lint fixes',
          },
        ]}
      />,
    )

    expect(textOf(r)).toContain('/lint')
    expect(textOf(r)).toContain('Run lint fixes')
  })

  it('sizes itself natively between the min and max heights', () => {
    // Native auto-grow handles multiline sizing: no fixed height, no manual
    // scrollEnabled toggling — the input grows to maxHeight and then scrolls.
    const r = renderComponent(<ChatInput value={'Line\n'.repeat(10)} {...chatInputDefaults} />)
    const input = r.root.findByType('TextInput' as any)
    const style = flattenStyle(input.props.style)

    expect(style.height).toBeUndefined()
    expect(style.minHeight).toBe(44)
    expect(style.maxHeight).toBe(280)
    expect(input.props.multiline).toBe(true)
    expect(input.props.scrollEnabled).toBeUndefined()
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

  it('caps long code until the user expands it', () => {
    const code = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n')
    const r = renderComponent(<CodeBlock code={code} language="ts" />)

    expect(textOf(r)).toContain('Show 3 more lines')
    expect(textOf(r)).not.toContain('line 15')

    const expand = r.root
      .findAllByType('Pressable' as any)
      .find((button) => button.props.accessibilityLabel === 'Show 3 more lines')
    act(() => expand?.props.onPress())

    expect(textOf(r)).toContain('line 15')
    expect(textOf(r)).toContain('Show less')
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
