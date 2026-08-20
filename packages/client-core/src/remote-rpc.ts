import type { MachinePresence, RelayRpcFailureCode } from './types'

/** Five seconds beyond the relay's 30s routing deadline, leaving room for
 * delivery of its structured timeout before clients abandon the request. */
export const RELAY_RPC_TIMEOUT_MS = 35_000

/** Older relays expose only daemon_connected; newer ones publish RPC readiness. */
export function isDaemonRpcReady(presence: MachinePresence | null | undefined): boolean {
  return presence?.daemon_rpc_ready ?? presence?.daemon_connected ?? false
}

/** Turns relay-owned routing failures into actionable client diagnostics. */
export function relayRpcFailureMessage(
  failure: RelayRpcFailureCode | null | undefined,
  method: string,
) {
  switch (failure) {
    case 'method_unavailable':
      return method === 'snapshot.current'
        ? 'Desktop is connected, but sync is not ready yet. FalconDeck will retry automatically.'
        : 'Desktop is connected, but that action is not ready yet. Try again in a moment.'
    case 'request_conflict':
      return 'The relay rejected a duplicate request.'
    case 'responder_disconnected':
      return 'Desktop disconnected from the relay.'
    case 'timed_out':
      return 'Timed out waiting for a response.'
    default:
      return 'The request failed without details.'
  }
}
