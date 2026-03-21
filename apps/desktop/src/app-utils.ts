import { workspaceAccount, type AgentProvider, type ConversationItem, type WorkspaceSummary } from '@falcondeck/client-core'

export function markInteractiveRequestResolved(
  items: ConversationItem[],
  requestId: string,
): ConversationItem[] {
  return items.map((item) =>
    item.kind === 'interactive_request' && item.id === requestId
      ? { ...item, resolved: true }
      : item,
  )
}

export function providerLabel(provider: AgentProvider) {
  return provider === 'claude' ? 'Claude' : 'Codex'
}

export function workspaceSendBlockReason(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
) {
  if (!workspace) return 'Select a project to get started.'

  switch (workspace.status) {
    case 'connecting':
      return `${workspace.path.split('/').pop() ?? 'This project'} is still reconnecting. Wait a moment and try again.`
    case 'disconnected':
      return workspace.last_error ?? `${workspace.path.split('/').pop() ?? 'This project'} is disconnected. Reconnect it and try again.`
    case 'error':
      return workspace.last_error ?? `${workspace.path.split('/').pop() ?? 'This project'} is unavailable right now.`
    case 'needs_auth':
      return `Finish authentication for this project before using ${providerLabel(provider)}.`
    default:
      break
  }

  const account = workspaceAccount(workspace, provider)
  if (account?.status === 'needs_auth') {
    return `${providerLabel(provider)} needs authentication in this project before you can send messages.`
  }

  return null
}

export function normalizeSendError(message: string, provider: AgentProvider) {
  if (message.includes('is not currently connected to Claude')) {
    return 'This project is not connected to Claude yet. Wait for it to reconnect or switch the new thread to Codex.'
  }
  if (message.includes('is not currently connected to Codex')) {
    return 'This project is not connected to Codex yet. Wait for it to reconnect and try again.'
  }
  if (message.includes('workspace restore timed out')) {
    return `This project is still reconnecting to ${providerLabel(provider)}. Wait a moment and try again.`
  }
  return message
}
