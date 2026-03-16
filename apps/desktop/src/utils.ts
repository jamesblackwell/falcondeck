import type { RemoteStatusResponse, ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'

export function defaultModelId(workspace: WorkspaceSummary | null) {
  return workspace?.models.find((model) => model.is_default)?.id ?? workspace?.models[0]?.id ?? null
}

export function resolveThreadModelId(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
) {
  return preferredModelId ?? thread?.codex.model_id ?? defaultModelId(workspace)
}

export function reasoningOptions(
  thread: ThreadSummary | null,
  workspace: WorkspaceSummary | null,
  preferredModelId?: string | null,
) {
  const model = workspace?.models.find(
    (entry) => entry.id === resolveThreadModelId(thread, workspace, preferredModelId),
  )
  const options = model?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
  if (options.length > 0) return options
  return model?.default_reasoning_effort ? [model.default_reasoning_effort] : ['medium']
}

export function remoteTone(status: RemoteStatusResponse['status']) {
  switch (status) {
    case 'connected':
      return 'success' as const
    case 'device_trusted':
    case 'pairing_pending':
    case 'connecting':
    case 'degraded':
    case 'offline':
      return 'warning' as const
    case 'revoked':
    case 'error':
      return 'danger' as const
    default:
      return 'default' as const
  }
}

export function remoteHeadline(status: RemoteStatusResponse['status'] | undefined) {
  switch (status) {
    case 'connected':
      return 'Remote connected'
    case 'device_trusted':
      return 'Trusted device remembered'
    case 'connecting':
      return 'Connecting remote'
    case 'pairing_pending':
      return 'Waiting for claim'
    case 'degraded':
      return 'Remote degraded'
    case 'offline':
      return 'Remote offline'
    case 'revoked':
      return 'Remote revoked'
    case 'error':
      return 'Remote error'
    default:
      return 'Remote inactive'
  }
}

export function remoteDescription(status: RemoteStatusResponse | null) {
  switch (status?.status) {
    case 'connected':
      return 'A remote client is attached through the encrypted relay.'
    case 'device_trusted':
      return 'A trusted device is paired and ready to reconnect.'
    case 'connecting':
      return 'Reconnecting the trusted relay session.'
    case 'pairing_pending':
      return 'Scan the QR code or open the pairing link on your phone.'
    case 'degraded':
      return 'The relay session dropped and is retrying automatically.'
    case 'offline':
      return 'The relay is unreachable right now, but FalconDeck is still retrying.'
    case 'revoked':
      return status.last_error ?? 'The trusted device was revoked and must pair again.'
    case 'error':
      return status.last_error ?? 'Could not establish the relay bridge.'
    default:
      return 'Start pairing to connect this desktop to FalconDeck Remote.'
  }
}
