/**
 * User-facing connection language for the phone.
 *
 * The phone's socket is to the relay. The paired FalconDeck app on the
 * computer (desktop) is a separate hop. Never say "Mac": the desktop may be
 * Linux or Windows, and a down socket is usually the phone-to-relay link,
 * not the computer.
 */
export const CONNECTION_COPY = {
  pairing: 'Pairing this device…',
  pairingShort: 'Pairing…',
  claiming: 'Claiming pairing…',
  connecting: 'Connecting…',
  connectingToRelay: 'Connecting to relay…',
  reconnecting: 'Reconnecting to relay…',
  securing: 'Securing session…',
  securingDetail:
    'Your desktop is finishing the encrypted handshake for this device.',
  waitingForDesktop: 'Waiting for desktop…',
  waitingForDesktopDetail:
    'Keep FalconDeck open on your computer while it finishes pairing.',
  checkingDesktop: 'Checking desktop…',
  desktopOffline: 'Waiting for desktop…',
  desktopOfflineDetail:
    'Keep FalconDeck open on your computer. We’ll keep trying automatically.',
  repairing: 'Repairing sync…',
  repairingDetail: 'Desktop is online but not ready to sync yet.',
  syncing: 'Syncing your projects…',
  syncingStaleDetail: 'Threads may be a few seconds out of date.',
  reconnectingStaleDetail: 'Showing your last synced threads.',
  connected: 'Connected',
  notConnected: 'Not connected',
  notConnectedDetail: 'Pair this device from Settings.',
} as const

export const RELAY_TRANSPORT_ERRORS = {
  dropped: 'Lost the relay connection',
  closed: 'Relay connection closed',
  notReady: 'Not connected to the relay',
} as const

export function isRelayTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message === RELAY_TRANSPORT_ERRORS.dropped ||
    message === RELAY_TRANSPORT_ERRORS.closed ||
    message === RELAY_TRANSPORT_ERRORS.notReady ||
    /could not reach the relay|encrypted relay session is not ready|request timed out/i.test(
      message,
    )
  )
}
