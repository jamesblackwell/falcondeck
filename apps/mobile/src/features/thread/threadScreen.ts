import type { ConversationRenderBlock } from '@falcondeck/client-core'

export function getWorkspaceTitle(path: string | null | undefined): string {
  const title = path?.split('/').pop()
  return title && title.length > 0 ? title : 'FalconDeck'
}

export function shouldShowThinkingIndicator(
  blocks: ConversationRenderBlock[],
  isThreadRunning: boolean,
): boolean {
  if (!isThreadRunning) return false
  if (blocks.length === 0) return true

  const lastBlock = blocks[blocks.length - 1]
  if (!lastBlock) return true
  if (lastBlock.kind === 'tool_burst') return false

  return !(
    lastBlock.item.kind === 'tool_call' &&
    (lastBlock.item.status === 'running' || lastBlock.item.status === 'in_progress')
  )
}
