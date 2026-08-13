import type { RelayRpcFailureCode } from './types'

/** Five seconds beyond the relay's 30s routing deadline, leaving room for
 * delivery of its structured timeout before clients abandon the request. */
export const RELAY_RPC_TIMEOUT_MS = 35_000

/** Turns relay-owned routing failures into actionable client diagnostics. */
export function relayRpcFailureMessage(
  failure: RelayRpcFailureCode | null | undefined,
  method: string,
) {
  switch (failure) {
    case 'method_unavailable':
      return method === 'snapshot.current'
        ? 'Your Mac is connected, but snapshot.current is not registered. FalconDeck will retry automatically.'
        : `Your Mac is connected, but ${method} is not registered. Try again in a moment.`
    case 'request_conflict':
      return `The relay rejected a duplicate ${method} request.`
    case 'responder_disconnected':
      return `Your Mac disconnected while ${method} was running.`
    case 'timed_out':
      return `The relay timed out waiting for your Mac to finish ${method}.`
    default:
      return `Remote ${method} failed without details.`
  }
}
