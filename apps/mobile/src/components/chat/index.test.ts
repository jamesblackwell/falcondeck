import { describe, it, expect } from 'vitest'
import { ChatInput, MessageBubble, SessionListItem, ApprovalBanner, CodeBlock } from './index'

describe('chat barrel exports', () => {
  it('exports ChatInput', () => { expect(ChatInput).toBeDefined() })
  it('exports MessageBubble', () => { expect(MessageBubble).toBeDefined() })
  it('exports SessionListItem', () => { expect(SessionListItem).toBeDefined() })
  it('exports ApprovalBanner', () => { expect(ApprovalBanner).toBeDefined() })
  it('exports CodeBlock', () => { expect(CodeBlock).toBeDefined() })
})
