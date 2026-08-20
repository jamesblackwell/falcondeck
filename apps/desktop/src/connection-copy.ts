/**
 * User-facing connection language for the desktop shell.
 *
 * The window talks to the local FalconDeck process. Remote phones talk to the
 * relay, not to this computer directly. Keep those hops distinct, and never
 * say "Mac": the same app may run on Linux or Windows.
 */
export const CONNECTION_COPY = {
  stillConnecting: 'FalconDeck is still connecting.',
  notConnected: 'FalconDeck is not connected.',
  lostConnection: 'Lost the local connection. Reconnecting…',
  connectFailed: 'Could not connect. Retrying…',
  serverNotConnected: 'This server is not connected.',
} as const

export function falconDeckHttpError(status: number): string {
  return `FalconDeck returned ${status}.`
}
