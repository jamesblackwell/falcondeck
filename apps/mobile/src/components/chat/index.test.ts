import { describe, it, expect } from 'vitest'
import {
  ChatInput,
  SessionListItem,
  ApprovalBanner,
  CodeBlock,
  MarkdownRenderer,
  MessageRouter,
  UserMessageBlock,
  AssistantMessageBlock,
  ServiceBlock,
  ToolCallBlock,
  ToolBurstBlock,
  PlanBlock,
  DiffBlock,
  InteractiveRequestBlock,
  InputToolbar,
  StopButton,
  JumpToBottomFab,
  ThinkingIndicator,
} from './index'

describe('chat barrel exports', () => {
  it('exports ChatInput', () => { expect(ChatInput).toBeDefined() })
  it('exports SessionListItem', () => { expect(SessionListItem).toBeDefined() })
  it('exports ApprovalBanner', () => { expect(ApprovalBanner).toBeDefined() })
  it('exports CodeBlock', () => { expect(CodeBlock).toBeDefined() })
  it('exports MarkdownRenderer', () => { expect(MarkdownRenderer).toBeDefined() })
  it('exports MessageRouter', () => { expect(MessageRouter).toBeDefined() })
  it('exports UserMessageBlock', () => { expect(UserMessageBlock).toBeDefined() })
  it('exports AssistantMessageBlock', () => { expect(AssistantMessageBlock).toBeDefined() })
  it('exports ServiceBlock', () => { expect(ServiceBlock).toBeDefined() })
  it('exports ToolCallBlock', () => { expect(ToolCallBlock).toBeDefined() })
  it('exports ToolBurstBlock', () => { expect(ToolBurstBlock).toBeDefined() })
  it('exports PlanBlock', () => { expect(PlanBlock).toBeDefined() })
  it('exports DiffBlock', () => { expect(DiffBlock).toBeDefined() })
  it('exports InteractiveRequestBlock', () => { expect(InteractiveRequestBlock).toBeDefined() })
  it('exports InputToolbar', () => { expect(InputToolbar).toBeDefined() })
  it('exports StopButton', () => { expect(StopButton).toBeDefined() })
  it('exports JumpToBottomFab', () => { expect(JumpToBottomFab).toBeDefined() })
  it('exports ThinkingIndicator', () => { expect(ThinkingIndicator).toBeDefined() })
})
