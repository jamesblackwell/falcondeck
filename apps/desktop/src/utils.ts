import type { RemoteStatusResponse, ThreadSummary, WorkspaceSummary } from '@falcondeck/client-core'

function selectedModelId(thread: ThreadSummary | null, workspace: WorkspaceSummary | null) {
  return thread?.codex.model_id ?? workspace?.models.find((model) => model.is_default)?.id ?? null
}

export function reasoningOptions(thread: ThreadSummary | null, workspace: WorkspaceSummary | null) {
  const model = workspace?.models.find((entry) => entry.id === selectedModelId(thread, workspace))
  const options = model?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
  if (options.length > 0) return options
  return model?.default_reasoning_effort ? [model.default_reasoning_effort] : ['medium']
}

export function remoteTone(status: RemoteStatusResponse['status']) {
  switch (status) {
    case 'connected':
      return 'success' as const
    case 'error':
      return 'danger' as const
    case 'waiting_for_claim':
    case 'connecting':
      return 'warning' as const
    default:
      return 'default' as const
  }
}

export function remoteHeadline(status: RemoteStatusResponse['status'] | undefined) {
  switch (status) {
    case 'connected':
      return 'Remote connected'
    case 'connecting':
      return 'Connecting remote'
    case 'waiting_for_claim':
      return 'Waiting for claim'
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
    case 'connecting':
      return 'The pairing was claimed — negotiating relay bridge.'
    case 'waiting_for_claim':
      return 'Scan the QR code or open the pairing link on your phone.'
    case 'error':
      return status.last_error ?? 'Could not establish the relay bridge.'
    default:
      return 'Start pairing to connect this desktop to FalconDeck Remote.'
  }
}
