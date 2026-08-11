import {
  defaultProviderLabel,
  interactiveResolutionFromResponse,
  workspaceAccount,
  workspaceProviderLabel,
  type AgentProvider,
  type ConversationItem,
  type InteractiveResponsePayload,
  type WorkspaceSummary,
} from '@falcondeck/client-core'

export function markInteractiveRequestResolved(
  items: ConversationItem[],
  requestId: string,
  response: InteractiveResponsePayload,
): ConversationItem[] {
  const resolution = interactiveResolutionFromResponse(response)
  return items.map((item) =>
    item.kind === 'interactive_request' && item.id === requestId
      ? { ...item, resolved: true, resolution }
      : item,
  )
}

/** Provider display name when no workspace is on hand to supply its label. */
export function providerLabel(provider: AgentProvider) {
  return defaultProviderLabel(provider)
}

export function workspaceComposerDisabled(workspace: WorkspaceSummary | null | undefined) {
  if (!workspace) return true

  switch (workspace.status) {
    case 'connecting':
    case 'disconnected':
    case 'error':
    case 'needs_auth':
      return true
    default:
      return false
  }
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
      return `Finish authentication for this project before using ${workspaceProviderLabel(workspace, provider)}.`
    default:
      break
  }

  const account = workspaceAccount(workspace, provider)
  if (account?.status === 'needs_auth') {
    return `${workspaceProviderLabel(workspace, provider)} needs authentication in this project before you can send messages.`
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
