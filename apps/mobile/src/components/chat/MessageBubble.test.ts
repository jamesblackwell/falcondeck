/**
 * Tests for MessageBubble — validates that each ConversationItem kind
 * accesses the correct fields from the type union. These are logic tests,
 * not visual snapshot tests; we verify the component doesn't crash and
 * exercises each branch of the kind discriminator.
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import type { ConversationItem } from '@falcondeck/client-core'

import { MessageBubble } from './MessageBubble'

// Since we can't render React Native components in Node, we test the
// component function's return value directly — it returns React elements
// (or null) that we can inspect.

function render(item: ConversationItem) {
  // Call the unwrapped component function
  // memo wraps it, but we can access the inner function via .type
  const MemoizedComponent = MessageBubble as any
  const innerFn = MemoizedComponent.type ?? MemoizedComponent
  return innerFn({ item })
}

describe('MessageBubble', () => {
  it('returns null for reasoning items (never rendered)', () => {
    const item: ConversationItem = {
      kind: 'reasoning',
      id: 'r1',
      summary: 'thinking...',
      content: 'internal reasoning',
      created_at: '2026-03-16T10:00:00Z',
    }
    expect(render(item)).toBeNull()
  })

  it('renders user_message using item.text (not .content)', () => {
    const item: ConversationItem = {
      kind: 'user_message',
      id: 'u1',
      text: 'Hello there',
      attachments: [],
      created_at: '2026-03-16T10:00:00Z',
    }
    const result = render(item)
    expect(result).not.toBeNull()
    // Traverse the VDOM tree to find the text content
    const textContent = findTextContent(result)
    expect(textContent).toContain('Hello there')
  })

  it('renders assistant_message using item.text', () => {
    const item: ConversationItem = {
      kind: 'assistant_message',
      id: 'a1',
      text: 'I can help with that',
      created_at: '2026-03-16T10:01:00Z',
    }
    const result = render(item)
    expect(result).not.toBeNull()
    const textContent = findTextContent(result)
    expect(textContent).toContain('I can help with that')
  })

  it('renders tool_call using item.title (not .name)', () => {
    const item: ConversationItem = {
      kind: 'tool_call',
      id: 't1',
      title: 'Running bash command',
      tool_kind: 'bash',
      status: 'completed',
      output: 'success',
      exit_code: 0,
      created_at: '2026-03-16T10:02:00Z',
      completed_at: '2026-03-16T10:02:01Z',
    }
    const result = render(item)
    expect(result).not.toBeNull()
    const textContent = findTextContent(result)
    expect(textContent).toContain('Running bash command')
    expect(textContent).toContain('success')
  })

  it('renders tool_call without output when output is null', () => {
    const item: ConversationItem = {
      kind: 'tool_call',
      id: 't2',
      title: 'Editing file',
      tool_kind: 'edit',
      status: 'running',
      output: null,
      exit_code: null,
      created_at: '2026-03-16T10:02:00Z',
      completed_at: null,
    }
    const result = render(item)
    expect(result).not.toBeNull()
    const textContent = findTextContent(result)
    expect(textContent).toContain('Editing file')
    expect(textContent).not.toContain('null')
  })

  it('renders service using item.message (not .content)', () => {
    const item: ConversationItem = {
      kind: 'service',
      id: 's1',
      level: 'info',
      message: 'Session started',
      created_at: '2026-03-16T10:03:00Z',
    }
    const result = render(item)
    expect(result).not.toBeNull()
    const textContent = findTextContent(result)
    expect(textContent).toContain('Session started')
  })

  it('returns null for plan items (not yet implemented)', () => {
    const item: ConversationItem = {
      kind: 'plan',
      id: 'p1',
      plan: { explanation: 'Plan', steps: [{ step: 'Step 1', status: 'pending' }] },
      created_at: '2026-03-16T10:04:00Z',
    }
    expect(render(item)).toBeNull()
  })

  it('returns null for diff items (not yet implemented)', () => {
    const item: ConversationItem = {
      kind: 'diff',
      id: 'd1',
      diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
      created_at: '2026-03-16T10:05:00Z',
    }
    expect(render(item)).toBeNull()
  })

  it('returns null for approval items (handled by ApprovalBanner)', () => {
    const item: ConversationItem = {
      kind: 'interactive_request',
      id: 'ap1',
      request: {
        request_id: 'req1',
        workspace_id: 'w1',
        thread_id: 't1',
        method: 'bash',
        kind: 'approval',
        title: 'Run command',
        detail: null,
        command: 'ls',
        path: '/tmp',
        turn_id: null,
        item_id: null,
        questions: [],
        created_at: '2026-03-16T10:06:00Z',
      },
      created_at: '2026-03-16T10:06:00Z',
      resolved: false,
    }
    expect(render(item)).toBeNull()
  })
})

/**
 * Recursively extract all string children from a React element tree.
 * Works with the VDOM structure returned by component functions.
 */
function findTextContent(element: any): string {
  if (element == null) return ''
  if (typeof element === 'string') return element
  if (typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(findTextContent).join('')

  // React element: { type, props: { children, ... } }
  if (element.props?.children) {
    const children = element.props.children
    if (Array.isArray(children)) return children.map(findTextContent).join('')
    return findTextContent(children)
  }

  return ''
}
