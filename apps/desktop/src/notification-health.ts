import type {
  AttentionDeliveryCounter,
  PushDeliveryOutcome,
  PushTestDeviceResult,
  TrustedDevice,
} from '@falcondeck/client-core'

import type { DesktopDeliveryResult, DesktopPermission } from './desktop-notifications'

const PROVIDER_LABELS: Record<string, string> = { apns: 'Apple Push', expo: 'Expo' }
const KIND_LABELS: Record<string, string> = {
  review: 'Reviews',
  approval: 'Approvals',
  question: 'Questions',
  'turn-complete': 'Completed turns',
  'turn-error': 'Failed turns',
  test: 'Test',
}
const UNREGISTERED =
  'Not registered, so this device cannot get alerts. Open FalconDeck on it and turn on Push notifications in Settings.'

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

function outcomeText(outcome: PushDeliveryOutcome, detail?: string | null): string {
  switch (outcome) {
    case 'accepted':
      return 'accepted'
    case 'unregistered':
      return 'token expired, so it was cleared'
    case 'rejected':
      return detail ? `failed (${detail})` : 'failed'
    default:
      return 'unknown result'
  }
}

export function describeDevicePush(device: TrustedDevice): string {
  if (!device.push) return 'This relay needs an update before it can report delivery.'
  if (!device.push.provider) return UNREGISTERED
  const provider = providerLabel(device.push.provider)
  const last = device.push.last_delivery
  if (!last) return `Registered with ${provider}. Nothing sent since the relay last started.`
  const kind = KIND_LABELS[last.kind] ?? last.kind
  const when = new Date(last.at).toLocaleString()
  return `Registered with ${provider}. Last: ${kind}, ${outcomeText(last.outcome, last.detail)}, ${when}.`
}

export function describeTestResult(result: PushTestDeviceResult): string {
  const label = result.label ?? 'Paired device'
  if (!result.provider || !result.outcome) return `${label}: not registered, nothing sent.`
  return `${label}: ${outcomeText(result.outcome, result.detail)} by ${providerLabel(result.provider)}.`
}

export function describeDesktop(
  permission: DesktopPermission,
  last: DesktopDeliveryResult | null,
): string {
  const state = {
    granted: 'Allowed in macOS.',
    denied: 'Blocked in macOS. Allow FalconDeck in System Settings > Notifications.',
    default: 'macOS has not been asked yet. Send a test to get the prompt.',
    unsupported: 'System notifications are only available in the desktop app.',
  }[permission]
  if (!last) return state
  const when = new Date(last.at).toLocaleString()
  const outcome = {
    delivered: 'posted',
    not_allowed: 'not allowed',
    failed: 'failed',
  }[last.outcome]
  return `${state} Last alert ${outcome}, ${when}.`
}

export function describeDesktopTest(shown: boolean, permission: DesktopPermission): string {
  if (shown) return 'This Mac: posted.'
  if (permission === 'denied') return 'This Mac: blocked in System Settings > Notifications.'
  return 'This Mac: macOS did not record an answer or accept the alert, so nothing was shown.'
}

/** One sentence per kind, leaving out the reasons that did not happen. */
export function describeAttention(counters: AttentionDeliveryCounter[]): string[] {
  return counters.map((counter) => {
    const parts = [`${counter.delivered ?? counter.sent ?? 0} delivered`]
    if (counter.held) parts.push(`${counter.held} waiting for the relay`)
    if (counter.settled) parts.push(`${counter.settled} answered or read before they could go`)
    if (counter.suppressed_desktop_active) {
      parts.push(`${counter.suppressed_desktop_active} not sent because you were at the Mac`)
    }
    if (counter.suppressed_preferences) {
      parts.push(`${counter.suppressed_preferences} off in preferences`)
    }
    if (counter.expired) parts.push(`${counter.expired} expired after an hour waiting`)
    if (counter.evicted) parts.push(`${counter.evicted} dropped for newer ones`)
    if (counter.lost) parts.push(`${counter.lost} lost with no phone paired`)
    return `${KIND_LABELS[counter.kind] ?? counter.kind}: ${parts.join(', ')}.`
  })
}
