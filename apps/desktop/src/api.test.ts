import { afterEach, describe, expect, it, vi } from 'vitest'
import { openExternalUrl } from './api'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

afterEach(() => {
  delete window.__TAURI_INTERNALS__
  vi.restoreAllMocks()
  invoke.mockClear()
})

describe('openExternalUrl', () => {
  it.each(['http://localhost:5173/', 'http://127.0.0.1:3000/', 'http://192.168.1.20:5173/', 'https://example.com/'])('hands %s to the native opener', async (url) => {
    window.__TAURI_INTERNALS__ = {}
    await openExternalUrl(url)
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url })
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'http://user:secret@example.com', 'http://example.com/%0a'])('rejects unsafe URL %s', async (url) => {
    window.__TAURI_INTERNALS__ = {}
    const error = await openExternalUrl(url).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('can only open')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not treat the null return from noopener as an opening failure', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(openExternalUrl('http://localhost:5173/')).resolves.toBeUndefined()
    expect(open).toHaveBeenCalledWith('http://localhost:5173/', '_blank', 'noopener,noreferrer')
  })
})
