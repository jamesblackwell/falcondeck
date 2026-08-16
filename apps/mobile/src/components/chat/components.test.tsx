import React from 'react'
import * as Clipboard from 'expo-clipboard'
import { AccessibilityInfo } from 'react-native'
import { act } from 'react-test-renderer'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderComponent, cleanup, textOf } from '../../test/render'
import {
  resetSpeechSettings,
  updateSpeechSettings,
} from '../../features/speech/speechSettings'
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
    const r = renderComponent(
      <ApprovalBanner
        approval={approval()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    expect(textOf(r)).toContain('Run command')
  })

  it('renders with null command', () => {
    const r = renderComponent(
      <ApprovalBanner
        approval={approval({ command: null })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with null detail', () => {
    const r = renderComponent(
      <ApprovalBanner
        approval={approval({ detail: null })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with both null', () => {
    const r = renderComponent(
      <ApprovalBanner
        approval={approval({ command: null, detail: null })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('shows one queue position without rendering duplicated raw JSON', () => {
    const item = approval({
      detail:
        '{"command":"rm -rf node_modules","description":"Clean dependencies"}',
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
    expect(
      approvalDetail(approval({ detail: '{"command":"rm -rf node_modules"}' })),
    ).toBeNull()
  })

  it('makes exact approval context selectable while action controls stay pressable', () => {
    const r = renderComponent(
      <ApprovalBanner
        approval={approval({
          title: 'Run the release checks?',
          command: 'npm run verify',
          detail: 'Runs the complete pre-release suite.',
          path: '/workspace/falcondeck',
        })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    const selectableText = r.root
      .findAllByType('Text' as any)
      .filter((node) => node.props.selectable === true)
      .flatMap((node) =>
        node.children.filter(
          (child): child is string => typeof child === 'string',
        ),
      )
      .join('\n')

    expect(selectableText).toContain('Run the release checks?')
    expect(selectableText).toContain('npm run verify')
    expect(selectableText).toContain('Runs the complete pre-release suite.')
    expect(selectableText).toContain('/workspace/falcondeck')
    const pressableLabels = r.root
      .findAllByType('Pressable' as any)
      .flatMap((pressable) => pressable.findAllByType('Text' as any))
      .flatMap((node) =>
        node.children.filter(
          (child): child is string => typeof child === 'string',
        ),
      )
    expect(pressableLabels).toContain('Copy')
    expect(pressableLabels).toContain('Deny')
    expect(pressableLabels).toContain('Allow')
  })

  it('bounds long approval commands without hiding the remainder', () => {
    const command = Array.from(
      { length: 7 },
      (_, index) => `release step ${index + 1}`,
    ).join('\n')
    const r = renderComponent(
      <ApprovalBanner
        approval={approval({ command, detail: null })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    )

    expect(textOf(r)).toContain('release step 4')
    expect(textOf(r)).not.toContain('release step 7')
    const expand = r.root.findByProps({
      accessibilityLabel: 'Show 3 more lines',
    })
    act(() => expand.props.onPress())
    expect(textOf(r)).toContain('release step 7')
    expect(
      r.root.findByProps({ accessibilityLabel: 'Copy code' }),
    ).toBeDefined()
  })
})

describe('ChatInput component', () => {
  const imageCapableAgent = {
    supports_review: false,
    supports_goals: false,
    supports_images: true,
    supports_skills: true,
    supports_interrupt: true,
    supports_steering: false,
    supports_forking: false,
    sandbox_modes: [],
    permission_modes: [],
  }
  const chatInputDefaults = {
    onChangeText: vi.fn(),
    onSubmit: vi.fn(),
    onPickImages: vi.fn(),
    onPasteImage: vi.fn(),
    onRemoveAttachment: vi.fn(),
    attachments: [],
    skills: [],
    models: [],
    selectedModel: null,
    selectedEffort: 'medium',
    effortOptions: ['low', 'medium', 'high'],
    selectedProvider: 'codex' as const,
    capabilities: imageCapableAgent,
    showProviderSelector: false,
    onSelectModel: vi.fn(),
    onSelectEffort: vi.fn(),
    onSelectProvider: vi.fn(),
  }

  it('renders empty', () => {
    const r = renderComponent(<ChatInput value="" {...chatInputDefaults} />)
    expect(r.toJSON()).toBeTruthy()
    expect(r.root.findByProps({ accessibilityLabel: 'Record voice message' })).toBeDefined()
  })

  it('renders with text', () => {
    const r = renderComponent(
      <ChatInput value="Hello" {...chatInputDefaults} />,
    )
    expect(r.toJSON()).toBeTruthy()
    expect(r.root.findByProps({ accessibilityLabel: 'Send message' })).toBeDefined()
  })

  it('asks for a speech provider on first mic use', () => {
    const r = renderComponent(<ChatInput value="" {...chatInputDefaults} />)
    act(() => {
      r.root.findByProps({ accessibilityLabel: 'Record voice message' }).props.onPress()
    })

    expect(textOf(r)).toContain('Voice input')
    expect(textOf(r)).toContain('On-device')
    expect(textOf(r)).toContain('OpenRouter')
  })

  it('records inline without a chooser once a provider is configured', () => {
    updateSpeechSettings({ provider: 'on-device' })
    try {
      const r = renderComponent(<ChatInput value="" {...chatInputDefaults} />)
      act(() => {
        r.root
          .findByProps({ accessibilityLabel: 'Record voice message' })
          .props.onPress()
      })

      expect(
        r.root.findByProps({ accessibilityLabel: 'Cancel voice input' }),
      ).toBeDefined()
      // The composer footer (including the mic button) yields to the session.
      expect(
        r.root.findAllByProps({ accessibilityLabel: 'Record voice message' }),
      ).toHaveLength(0)
    } finally {
      resetSpeechSettings()
    }
  })

  it('renders disabled', () => {
    const r = renderComponent(
      <ChatInput value="" {...chatInputDefaults} disabled />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with custom placeholder', () => {
    const r = renderComponent(
      <ChatInput value="" {...chatInputDefaults} placeholder="Custom..." />,
    )
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
    expect(textOf(r)).toContain('Paste image')
    expect(textOf(r)).toContain('Agent')
  })

  it('removes image actions when the selected agent does not support them', () => {
    const r = renderComponent(
      <ChatInput
        value=""
        {...chatInputDefaults}
        capabilities={{ ...imageCapableAgent, supports_images: false }}
      />,
    )

    expect(
      r.root
        .findAllByType('Pressable' as any)
        .some((button) => button.props.accessibilityLabel === 'Add to prompt'),
    ).toBe(false)
    expect(textOf(r)).not.toContain('Photos')
    expect(textOf(r)).not.toContain('Paste image')
  })

  it('pastes a clipboard image from the plus menu', () => {
    const onPasteImage = vi.fn()
    const r = renderComponent(
      <ChatInput
        value=""
        {...chatInputDefaults}
        onPasteImage={onPasteImage}
      />,
    )

    act(() => {
      r.root.findByProps({ accessibilityLabel: 'Add to prompt' }).props.onPress()
    })
    act(() => {
      r.root.findByProps({ accessibilityLabel: 'Paste image' }).props.onPress()
    })

    expect(onPasteImage).toHaveBeenCalledTimes(1)
  })

  it('shows why existing images cannot be sent to an unsupported agent', () => {
    const reason =
      'The selected agent does not support image attachments. Remove the image or choose an agent that supports images.'
    const r = renderComponent(
      <ChatInput
        value=""
        {...chatInputDefaults}
        attachments={[
          {
            type: 'image',
            id: 'img-unsupported',
            name: 'diagram.png',
            mime_type: 'image/png',
            url: 'data:image/png;base64,abc',
          },
        ]}
        capabilities={{ ...imageCapableAgent, supports_images: false }}
        sendDisabled
        sendDisabledReason={reason}
      />,
    )

    expect(textOf(r)).toContain(reason)
    expect(
      r.root.findByProps({ accessibilityLabel: 'Send message' }).props.disabled,
    ).toBe(true)
  })

  it('submits while the thread is running', () => {
    const onSubmit = vi.fn()
    const r = renderComponent(
      <ChatInput
        value="Steer the agent"
        {...chatInputDefaults}
        onSubmit={onSubmit}
      />,
    )
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

  it('keeps drafting available while only sending is disabled', () => {
    const onSubmit = vi.fn()
    const onPickImages = vi.fn()
    const r = renderComponent(
      <ChatInput
        value="Draft while reconnecting"
        {...chatInputDefaults}
        onSubmit={onSubmit}
        onPickImages={onPickImages}
        sendDisabled
        sendDisabledReason="Reconnect to send"
      />,
    )
    const input = r.root.findByType('TextInput' as any)
    const buttons = r.root.findAllByType('Pressable' as any)
    const addButton = buttons.find(
      (button) => button.props.accessibilityLabel === 'Add to prompt',
    )
    const sendButton = buttons.find(
      (button) => button.props.accessibilityLabel === 'Send message',
    )

    expect(input.props.editable).toBe(true)
    expect(addButton?.props.disabled).toBeFalsy()
    expect(sendButton?.props.disabled).toBe(true)
    expect(sendButton?.props.accessibilityHint).toBe('Reconnect to send')
    act(() => sendButton?.props.onPress())
    expect(onSubmit).not.toHaveBeenCalled()
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

  it('offers the built-in goal command when the provider supports goals', () => {
    const onChangeText = vi.fn()
    const onGoalCommand = vi.fn()
    const r = renderComponent(
      <ChatInput
        value="/goal"
        {...chatInputDefaults}
        onChangeText={onChangeText}
        onGoalCommand={onGoalCommand}
        capabilities={{ ...imageCapableAgent, supports_goals: true }}
      />,
    )

    expect(textOf(r)).toContain('Set a goal to keep pursuing')
    act(() => {
      r.root.findByProps({ accessibilityLabel: 'Set a goal' }).props.onPress()
    })
    expect(onChangeText).toHaveBeenCalledWith('')
    expect(onGoalCommand).toHaveBeenCalledTimes(1)
  })

  it('sizes itself natively between the min and max heights', () => {
    // Native auto-grow handles multiline sizing: no fixed height, no manual
    // scrollEnabled toggling — the input grows to maxHeight and then scrolls.
    const r = renderComponent(
      <ChatInput value={'Line\n'.repeat(10)} {...chatInputDefaults} />,
    )
    const input = r.root.findByType('TextInput' as any)
    const style = flattenStyle(input.props.style)

    expect(style.height).toBeUndefined()
    expect(style.minHeight).toBe(48)
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
    expect(
      r.root.findByProps({ accessibilityLabel: 'Copy code' }),
    ).toBeDefined()
    expect(
      r.root
        .findAllByType('Text' as any)
        .some((node) => node.props.selectable === true),
    ).toBe(true)
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
    const r = renderComponent(
      <CodeBlock code={'+added\n-removed\n context'} language="diff" />,
    )
    expect(r.toJSON()).toBeTruthy()
    expect(
      r.root
        .findAllByType('Text' as any)
        .filter((node) => node.props.selectable === true),
    ).toHaveLength(3)
  })

  it('caps long code until the user expands it', () => {
    const code = Array.from(
      { length: 15 },
      (_, index) => `line ${index + 1}`,
    ).join('\n')
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

  it('uses singular grammar for a one-line disclosure', () => {
    const code = Array.from(
      { length: 13 },
      (_, index) => `line ${index + 1}`,
    ).join('\n')
    const r = renderComponent(<CodeBlock code={code} language="text" />)

    expect(
      r.root.findByProps({ accessibilityLabel: 'Show 1 more line' }),
    ).toBeDefined()
    expect(textOf(r)).toContain('Show 1 more line')
  })

  it('keeps pathological output bounded after expansion while copying the full value', () => {
    const code = Array.from(
      { length: 600 },
      (_, index) => `line ${index + 1}`,
    ).join('\n')
    const r = renderComponent(<CodeBlock code={code} language="text" />)
    const expand = r.root
      .findAllByType('Pressable' as any)
      .find(
        (button) => button.props.accessibilityLabel === 'Show 388 more lines',
      )

    act(() => expand?.props.onPress())

    expect(textOf(r)).toContain('line 400')
    expect(textOf(r)).not.toContain('line 401')
    expect(textOf(r)).toContain('Display limited for performance')
    expect(
      r.root.findByProps({ accessibilityLabel: 'Copy code' }),
    ).toBeDefined()
  })

  it('confirms a complete code copy only after the native write resolves', async () => {
    let resolveCopy: (() => void) | null = null
    const copy = vi.spyOn(Clipboard, 'setStringAsync').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCopy = () => resolve(true)
        }),
    )
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility')
    const code = 'const complete = true'
    const r = renderComponent(<CodeBlock code={code} language="ts" />)

    act(() =>
      r.root.findByProps({ accessibilityLabel: 'Copy code' }).props.onPress({}),
    )
    expect(
      r.root.findAllByProps({ accessibilityLabel: 'Code copied' }),
    ).toHaveLength(0)

    await act(async () => {
      resolveCopy?.()
      await Promise.resolve()
    })

    expect(copy).toHaveBeenCalledWith(code)
    expect(textOf(r)).toContain('Copied')
    expect(
      r.root.findByProps({ accessibilityLabel: 'Code copied' }),
    ).toBeDefined()
    expect(announce).toHaveBeenCalledWith('Code copied')
    copy.mockRestore()
    announce.mockRestore()
  })
})

describe('SessionListItem component', () => {
  it('renders unselected', () => {
    const r = renderComponent(
      <SessionListItem
        thread={thread({ id: 't1', title: 'Test' })}
        workspaceId="w1"
        isSelected={false}
        onSelectThread={vi.fn()}
      />,
    )
    expect(textOf(r)).toContain('Test')
  })

  it('renders selected', () => {
    const r = renderComponent(
      <SessionListItem
        thread={thread({ id: 't1', title: 'Test' })}
        workspaceId="w1"
        isSelected={true}
        onSelectThread={vi.fn()}
      />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders running', () => {
    const r = renderComponent(
      <SessionListItem
        thread={thread({ id: 't1', title: 'Running', status: 'running' })}
        workspaceId="w1"
        isSelected={false}
        onSelectThread={vi.fn()}
      />,
    )
    expect(r.toJSON()).toBeTruthy()
  })

  it('renders with old date (days ago)', () => {
    const oldDate = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const r = renderComponent(
      <SessionListItem
        thread={thread({ id: 't1', title: 'Old', updated_at: oldDate })}
        workspaceId="w1"
        isSelected={false}
        onSelectThread={vi.fn()}
      />,
    )
    expect(textOf(r)).toContain('3d')
  })

  it('renders with hours-ago date', () => {
    const hoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString()
    const r = renderComponent(
      <SessionListItem
        thread={thread({ id: 't1', title: 'Hours', updated_at: hoursAgo })}
        workspaceId="w1"
        isSelected={false}
        onSelectThread={vi.fn()}
      />,
    )
    expect(textOf(r)).toContain('5h')
  })
})
