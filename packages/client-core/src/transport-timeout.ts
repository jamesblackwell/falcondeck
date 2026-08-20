export const DEFAULT_FETCH_TIMEOUT_MS = 15_000
export const WEBSOCKET_CONNECT_TIMEOUT_MS = 20_000

/** Run transport setup with a hard deadline so reconnect backoff can resume. */
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
      throw new Error('Request timed out; check your connection and try again')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
