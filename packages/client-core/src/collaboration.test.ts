import { describe, expect, it } from 'vitest'

import {
  approvalPolicyForProvider,
  imageAttachmentSendBlockReason,
  NO_AGENT_CAPABILITIES,
} from './collaboration'

describe('permission defaults', () => {
  it('uses Codex full bypass when no mode is selected', () => {
    expect(approvalPolicyForProvider('codex', null)).toBe('never')
    expect(approvalPolicyForProvider('codex', 'default')).toBe('on-request')
    expect(approvalPolicyForProvider('codex', 'never')).toBe('never')
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
