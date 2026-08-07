import { memo, useCallback } from 'react'

import type { ConversationRenderBlock } from '@falcondeck/client-core'

import { useSessionActions } from '@/hooks/useSessionActions'

import { UserMessageBlock } from './UserMessageBlock'
import { AssistantMessageBlock } from './AssistantMessageBlock'
import { ServiceBlock } from './ServiceBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolBurstBlock } from './ToolBurstBlock'
import { WorkSessionBlock } from './WorkSessionBlock'
import { PlanBlock } from './PlanBlock'
import { DiffBlock } from './DiffBlock'
import { InteractiveRequestBlock } from './InteractiveRequestBlock'

interface MessageRouterProps {
  item: ConversationRenderBlock
}

export const MessageRouter = memo(function MessageRouter({ item: block }: MessageRouterProps) {
  const { respondApproval } = useSessionActions()

  const handleAllow = useCallback(
    (id: string) => void respondApproval(id, 'allow'),
    [respondApproval],
  )
  const handleDeny = useCallback(
    (id: string) => void respondApproval(id, 'deny'),
    [respondApproval],
  )

  if (block.kind === 'tool_summary') {
    return (
      <ToolBurstBlock
        items={block.items}
        summary={block.summary}
        defaultOpen={block.default_open}
        suppressDetail={block.suppress_read_only_detail}
      />
    )
  }

  if (block.kind === 'work_session') {
    return (
      <WorkSessionBlock
        items={block.items}
        running={block.running}
        startedAt={block.started_at}
        completedAt={block.completed_at}
      />
    )
  }

  const { item } = block

  switch (item.kind) {
    case 'user_message':
      return <UserMessageBlock item={item} />
    case 'assistant_message':
      return <AssistantMessageBlock item={item} />
    case 'service':
      return <ServiceBlock item={item} />
    case 'tool_call':
      return (
        <ToolCallBlock
          item={item}
          defaultOpen={block.default_open}
          suppressDetail={block.suppress_read_only_detail}
        />
      )
    case 'plan':
      return <PlanBlock item={item} />
    case 'diff':
      return <DiffBlock item={item} defaultOpen={block.default_open} />
    case 'interactive_request':
      return (
        <InteractiveRequestBlock
          item={item}
          onAllow={handleAllow}
          onDeny={handleDeny}
        />
      )
    default:
      return null
  }
})
