/**
 * fetch with a hard timeout. React Native's fetch has no default deadline, so
 * a request that hangs (network transition, dead Wi-Fi, unreachable relay)
 * would otherwise leave callers stuck forever — the pairing screen frozen at
 * "Claiming…" or the connection at "Connecting…" with no reconnect scheduled.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000

export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Request timed out — check your connection and try again')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
