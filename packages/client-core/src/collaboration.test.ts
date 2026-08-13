import { describe, expect, it } from 'vitest'

import {
  approvalPolicyForProvider,
  imageAttachmentSendBlockReason,
  NO_AGENT_CAPABILITIES,
  threadAgentCapabilities,
} from './collaboration'

describe('permission defaults', () => {
  it('uses Codex full bypass when no mode is selected', () => {
    expect(approvalPolicyForProvider('codex', null)).toBe('never')
    expect(approvalPolicyForProvider('codex', 'default')).toBe('on-request')
    expect(approvalPolicyForProvider('codex', 'never')).toBe('never')
  })
})

describe('thread transport capabilities', () => {
  const workspace = {
    agents: [
      {
        provider: 'opencode',
        capabilities: { ...NO_AGENT_CAPABILITIES, supports_steering: true },
      },
    ],
  } as any

  it('offers steering only on native OpenCode threads', () => {
    expect(
      threadAgentCapabilities(workspace, 'opencode', {
        provider: 'opencode',
        provider_transport: 'native',
      } as any).supports_steering,
    ).toBe(true)
    expect(
      threadAgentCapabilities(workspace, 'opencode', {
        provider: 'opencode',
        provider_transport: 'acp',
      } as any).supports_steering,
    ).toBe(false)
  })
})

describe('image attachment capability gating', () => {
  it('blocks unsupported image turns without treating an empty composer as an error', () => {
    expect(imageAttachmentSendBlockReason(NO_AGENT_CAPABILITIES, 1)).toBe(
      'The selected agent does not support image attachments. Remove the image or choose an agent that supports images.',
    )
    expect(imageAttachmentSendBlockReason(NO_AGENT_CAPABILITIES, 2)).toContain(
      'Remove the images',
    )
    expect(imageAttachmentSendBlockReason(NO_AGENT_CAPABILITIES, 0)).toBeNull()
  })

  it('allows images only when the provider advertises support', () => {
    expect(
      imageAttachmentSendBlockReason(
        { ...NO_AGENT_CAPABILITIES, supports_images: true },
        2,
      ),
    ).toBeNull()
  })
})
