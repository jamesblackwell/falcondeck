import {
  defaultProviderLabel,
  interactiveResolutionFromResponse,
  wasTurnInterruptedByShutdown,
  workspaceAccount,
  workspaceAgent,
  workspaceProviderLabel,
  type AgentProvider,
  type ConversationItem,
  type InteractiveResponsePayload,
  type ThreadSummary,
  type WorkspaceSummary,
} from '@falcondeck/client-core'

/**
 * Threads to offer in the launch-time "continue what the quit stopped"
 * prompt, or null while it is too early to ask.
 *
 * Projects show up in the snapshot before the daemon has finished hydrating
 * them, and a turn started mid-hydration races the rebuilt thread list — so
 * asking is held until every project has finished connecting. Remote hosts
 * report their threads after the local snapshot, and waiting for them keeps
 * the prompt from appearing twice with different contents.
 */
export function stoppedThreadsToOffer({
  threads,
  workspaces,
  remoteHosts,
}: {
  threads: readonly ThreadSummary[] | undefined
  workspaces: readonly WorkspaceSummary[] | undefined
  remoteHosts: readonly { hasSnapshot: boolean; isConnected: boolean }[]
}): ThreadSummary[] | null {
  if (!threads || !workspaces) return null
  if (workspaces.some((workspace) => workspace.status === 'connecting')) return null
  if (remoteHosts.some((host) => host.isConnected && !host.hasSnapshot)) return null
  return threads.filter(
    (thread) => !thread.is_archived && wasTurnInterruptedByShutdown(thread),
  )
}

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
  // Status is not "no project". A selected workspace must stay typeable while
  // restore catches up; send is gated separately.
  return !workspace
}

function workspaceProviderCanSend(
  workspace: WorkspaceSummary,
  provider: AgentProvider,
) {
  const agent = workspaceAgent(workspace, provider)
  if (!agent) return false
  if (agent.account.status === 'needs_auth') return false
  if (agent.account.status === 'ready') return true
  // Placeholder catalogs (Grok models before the first handshake) are enough
  // to start a turn; the daemon connects that provider on first use.
  return agent.models.length > 0
}

export function workspaceSendBlockReason(
  workspace: WorkspaceSummary | null | undefined,
  provider: AgentProvider,
) {
  if (!workspace) return 'Select a project to get started.'

  if (workspaceProviderCanSend(workspace, provider)) {
    return null
  }

  switch (workspace.status) {
    case 'connecting':
      return `Reconnecting to ${workspace.path.split('/').pop() ?? 'this project'}. You can keep drafting while it reconnects.`
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
    if (provider === 'claude') {
      return 'Claude is logged out. Run `claude auth login` before sending messages.'
    }
    if (provider === 'agy') {
      return 'Antigravity is logged out. Run `agy` in a terminal to sign in before sending messages.'
    }
    return `${workspaceProviderLabel(workspace, provider)} needs authentication in this project before you can send messages.`
  }

  return null
}

export function normalizeSendError(message: string, provider: AgentProvider) {
  if (message.includes('is not currently connected to Claude')) {
    return 'This project is not connected to Claude yet. Wait for it to reconnect or switch the new thread to Codex.'
  }
  if (message.includes('is not currently connected to Antigravity')) {
    return 'This project is not connected to Antigravity yet. Wait for it to reconnect or switch the new thread to another agent.'
  }
  if (message.includes('is not currently connected to Codex')) {
    return 'This project is not connected to Codex yet. Wait for it to reconnect and try again.'
  }
  if (message.includes('workspace restore timed out')) {
    return `This project is still reconnecting to ${providerLabel(provider)}. Wait a moment and try again.`
  }
  return message
}
