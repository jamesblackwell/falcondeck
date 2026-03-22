import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { respondApprovalMock } = vi.hoisted(() => ({
  respondApprovalMock: vi.fn(),
}))

vi.mock('react-native-reanimated', () => ({
  View: 'Animated.View',
  useSharedValue: (init: any) => ({ value: init }),
  useAnimatedStyle: (fn: any) => fn(),
  useDerivedValue: (fn: any) => ({ value: fn() }),
  withTiming: (value: any) => value,
  withRepeat: (value: any) => value,
  withSequence: (...values: any[]) => values[0],
  withDelay: (_delay: any, value: any) => value,
  Easing: {
    out: (fn: any) => fn,
    cubic: (t: any) => t,
  },
  default: {
    View: 'Animated.View',
    createAnimatedComponent: (component: any) => component,
  },
}))

vi.mock('@/hooks/useSessionActions', () => ({
  useSessionActions: () => ({
    respondApproval: respondApprovalMock,
  }),
}))

import { cleanup, renderComponent, textOf } from '@/test/render'

import { AssistantMessageBlock } from './AssistantMessageBlock'
import { DiffBlock } from './DiffBlock'
import { InputToolbar } from './InputToolbar'
import { InteractiveRequestBlock } from './InteractiveRequestBlock'
import { JumpToBottomFab } from './JumpToBottomFab'
import { MarkdownRenderer } from './MarkdownRenderer'
import { MessageRouter } from './MessageRouter'
import { PlanBlock } from './PlanBlock'
import { ServiceBlock } from './ServiceBlock'
import { StopButton } from './StopButton'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ToolBurstBlock } from './ToolBurstBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { UserMessageBlock } from './UserMessageBlock'

afterEach(() => {
  cleanup()
  respondApprovalMock.mockReset()
})

describe('chat behavior components', () => {
  beforeEach(() => {
    respondApprovalMock.mockReset()
  })

  it('renders markdown-driven message blocks', () => {
    const assistant = renderComponent(
      <AssistantMessageBlock item={{ kind: 'assistant_message', id: 'a1', text: 'Assistant text', created_at: '2026-03-16T10:00:00Z' }} />,
    )
    const user = renderComponent(
      <UserMessageBlock item={{ kind: 'user_message', id: 'u1', text: 'User text', attachments: [], created_at: '2026-03-16T10:00:00Z' }} />,
    )
    const markdown = renderComponent(<MarkdownRenderer text="Plain markdown text" />)

    expect(textOf(assistant)).toContain('Assistant text')
    expect(textOf(user)).toContain('User text')
    expect(textOf(markdown)).toContain('Plain markdown text')
  })

  it('renders service messages and thinking indicator', () => {
    const service = renderComponent(
      <ServiceBlock item={{ kind: 'service', id: 's1', level: 'info', message: 'Background sync', created_at: '2026-03-16T10:00:00Z' }} />,
    )
    const thinking = renderComponent(<ThinkingIndicator />)

    expect(textOf(service)).toContain('Background sync')
    expect(thinking.toJSON()).toBeTruthy()
  })

  it('renders model and effort chips in the toolbar', () => {
    const renderer = renderComponent(
      <InputToolbar
        models={[
          { id: 'gpt-5', label: 'GPT-5', is_default: true } as any,
          { id: 'gpt-5-mini', label: 'GPT-5 Mini', is_default: false } as any,
        ]}
        selectedModel="gpt-5"
        selectedEffort="medium"
        onSelectModel={vi.fn()}
        onSelectEffort={vi.fn()}
      />,
    )

    expect(textOf(renderer)).toContain('GPT-5')
    expect(textOf(renderer)).toContain('Medium')
  })

  it('handles stop and jump-to-bottom actions', () => {
    const onStop = vi.fn()
    const onJump = vi.fn()
    const stop = renderComponent(<StopButton onPress={onStop} />)
    const jump = renderComponent(<JumpToBottomFab visible onPress={onJump} />)

    act(() => {
      stop.root.findByType('Pressable' as any).props.onPress()
      jump.root.findByType('Pressable' as any).props.onPress()
    })

    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it('renders tool, diff, and plan blocks', () => {
    const tool = renderComponent(
      <ToolCallBlock
        item={{
          kind: 'tool_call',
          id: 'tool-1',
          title: 'Read file',
          tool_kind: 'read',
          status: 'completed',
          output: 'file contents',
          exit_code: 0,
          display: {
            is_read_only: true,
            has_side_effect: false,
            is_error: false,
            artifact_kind: 'none',
            summary_hint: null,
          },
          created_at: '2026-03-16T10:00:00Z',
          completed_at: '2026-03-16T10:00:01Z',
        }}
        defaultOpen={false}
        suppressDetail={false}
      />,
    )
    const burst = renderComponent(
      <ToolBurstBlock
        items={[
          {
            kind: 'tool_call',
            id: 'tool-2',
            title: 'Search repo',
            tool_kind: 'grep',
            status: 'completed',
            output: 'search output',
            exit_code: 0,
            display: {
              is_read_only: true,
              has_side_effect: false,
              is_error: false,
              artifact_kind: 'none',
              summary_hint: null,
            },
            created_at: '2026-03-16T10:00:00Z',
            completed_at: '2026-03-16T10:00:01Z',
          } as any,
        ]}
        summary={{
          count: 2,
          labels: ['read', 'grep'],
          started_at: '2026-03-16T10:00:00Z',
          completed_at: '2026-03-16T10:00:01Z',
          summary_hint: null,
        }}
        defaultOpen
        suppressDetail={false}
      />,
    )
    const diff = renderComponent(
      <DiffBlock
        item={{ kind: 'diff', id: 'd1', diff: '+added\n-removed', created_at: '2026-03-16T10:00:00Z' } as any}
        defaultOpen
      />,
    )
    const plan = renderComponent(
      <PlanBlock
        item={{
          kind: 'plan',
          id: 'p1',
          plan: {
            explanation: 'Plan explanation',
            steps: [
              { step: 'Inspect state', status: 'completed' },
              { step: 'Refactor list', status: 'in_progress' },
            ],
          },
          created_at: '2026-03-16T10:00:00Z',
        } as any}
      />,
    )

    expect(textOf(tool)).toContain('Read file')
    expect(textOf(burst)).toContain('2 read-only tools')
    expect(textOf(diff)).toContain('Diff')
    expect(textOf(plan)).toContain('Plan explanation')
    expect(textOf(plan)).toContain('Refactor list')
  })

  it('renders interactive requests and forwards approval responses from the router', () => {
    const onAllow = vi.fn()
    const onDeny = vi.fn()
    const block = renderComponent(
      <InteractiveRequestBlock
        item={{
          kind: 'interactive_request',
          id: 'ir-1',
          resolved: false,
          request: {
            request_id: 'req-1',
            kind: 'approval',
            title: 'Run command',
            detail: 'Needs approval',
            command: 'ls -la',
          },
          created_at: '2026-03-16T10:00:00Z',
        } as any}
        onAllow={onAllow}
        onDeny={onDeny}
      />,
    )

    const buttons = block.root.findAllByType('Pressable' as any)
    act(() => {
      buttons[0]!.props.onPress()
      buttons[1]!.props.onPress()
    })

    expect(onDeny).toHaveBeenCalledWith('req-1')
    expect(onAllow).toHaveBeenCalledWith('req-1')

    const router = renderComponent(
      <MessageRouter
        item={{
          id: 'router-1',
          kind: 'item',
          default_open: false,
          suppress_read_only_detail: false,
          item: {
            kind: 'interactive_request',
            id: 'ir-2',
            resolved: false,
            request: {
              request_id: 'req-2',
              kind: 'approval',
              title: 'Approve change',
              detail: 'Approve tool call',
              command: null,
            },
            created_at: '2026-03-16T10:00:00Z',
          },
        } as any}
      />,
    )

    const routerButtons = router.root.findAllByType('Pressable' as any)
    act(() => {
      routerButtons[0]!.props.onPress()
      routerButtons[1]!.props.onPress()
    })

    expect(respondApprovalMock).toHaveBeenNthCalledWith(1, 'req-2', 'deny')
    expect(respondApprovalMock).toHaveBeenNthCalledWith(2, 'req-2', 'allow')
  })

  it('routes common block kinds through the message router', () => {
    const renderer = renderComponent(
      <>
        <MessageRouter
          item={{
            id: 'user-router',
            kind: 'item',
            default_open: false,
            suppress_read_only_detail: false,
            item: { kind: 'user_message', id: 'u2', text: 'Hello router', attachments: [], created_at: '2026-03-16T10:00:00Z' },
          } as any}
        />
        <MessageRouter
          item={{
            id: 'service-router',
            kind: 'item',
            default_open: false,
            suppress_read_only_detail: false,
            item: { kind: 'service', id: 's2', level: 'warning', message: 'Router service', created_at: '2026-03-16T10:00:00Z' },
          } as any}
        />
        <MessageRouter
          item={{
            id: 'burst-router',
            kind: 'tool_burst',
            default_open: false,
            suppress_read_only_detail: false,
            items: [],
            summary: {
              count: 1,
              labels: ['read'],
              started_at: '2026-03-16T10:00:00Z',
              completed_at: '2026-03-16T10:00:01Z',
              summary_hint: null,
            },
          } as any}
        />
      </>,
    )

    expect(textOf(renderer)).toContain('Hello router')
    expect(textOf(renderer)).toContain('Router service')
    expect(textOf(renderer)).toContain('1 read-only tool')
  })
})
