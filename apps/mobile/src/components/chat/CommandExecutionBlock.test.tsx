import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import type { ConversationItem } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '@/test/render'
import { ToolCallBlock } from './ToolCallBlock'

afterEach(cleanup)

const item: Extract<ConversationItem, { kind: 'tool_call' }> = {
  kind: 'tool_call',
  id: 'command-1',
  title: 'rg streaming src',
  tool_kind: 'commandExecution',
  status: 'completed',
  output: 'src/chat.ts:42',
  exit_code: 0,
  display: {
    is_read_only: true,
    has_side_effect: false,
    is_error: false,
    lifecycle: 'succeeded',
    artifact_kind: 'command_output',
    activity_kind: 'search',
    history_mode: 'full',
    summary_hint: null,
  },
  detail: {
    kind: 'command_execution',
    command: 'rg streaming src',
    cwd: '/workspace/falcondeck',
    actions: [{
      action_kind: 'search',
      command: 'rg streaming src',
      name: null,
      path: 'src',
      query: 'streaming',
    }],
    process_id: '4242',
    duration_ms: 37,
    source: 'agent',
  },
  created_at: '2026-08-09T10:00:00Z',
  completed_at: '2026-08-09T10:00:01Z',
}

describe('structured command execution output', () => {
  it('reveals command context and output accessibly', () => {
    const renderer = renderComponent(
      <ToolCallBlock item={item} defaultOpen={false} suppressDetail={false} />,
    )
    const disclosure = renderer.root.findByProps({
      accessibilityLabel: 'rg streaming src, Completed',
    })
    act(() => disclosure.props.onPress())
    const text = textOf(renderer)
    expect(text).toContain('cwd: /workspace/falcondeck')
    expect(text).toContain('37 ms')
    expect(text).toContain('search · src · streaming')
    expect(text).toContain('src/chat.ts:42')
    expect(disclosure.props.accessibilityState).toEqual({ expanded: true, disabled: false })
    const renderedNodeText = (node: { children: Array<string | { children: any[] }> }): string =>
      node.children
        .map((child) => typeof child === 'string' ? child : renderedNodeText(child))
        .join('')
    const selectableText = renderer.root
      .findAllByType('Text' as any)
      .filter((node) => node.props.selectable === true)
      .map((node) => renderedNodeText(node as any))
      .join('\n')
    expect(selectableText).toContain('cwd: /workspace/falcondeck')
    expect(selectableText).toContain('search · src · streaming')
    expect(selectableText).toContain('src/chat.ts:42')
  })

  it('bounds long partial output and keeps the complete result one action away', () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
    const renderer = renderComponent(
      <ToolCallBlock
        item={{
          ...item,
          status: 'interrupted',
          output,
          exit_code: null,
          display: { ...item.display, lifecycle: 'interrupted' },
        }}
        defaultOpen
        suppressDetail={false}
      />,
    )

    expect(textOf(renderer)).toContain('line 12')
    expect(textOf(renderer)).not.toContain('line 20')
    expect(textOf(renderer)).toContain('Show 8 more lines')
    expect(renderer.root.findByProps({ accessibilityLabel: 'Copy code' })).toBeDefined()

    const expand = renderer.root.findByProps({ accessibilityLabel: 'Show 8 more lines' })
    act(() => expand.props.onPress())
    expect(textOf(renderer)).toContain('line 20')
  })
})
