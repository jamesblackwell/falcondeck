import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureMicrophonePermission,
  invalidateMicrophonePermissionCache,
  warmMicrophonePermission,
} from './microphonePermission'

describe('microphone permission warm-up', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateMicrophonePermissionCache()
  })

  it('reuses a read-only warm-up instead of requesting permission on mic tap', async () => {
    vi.mocked(getRecordingPermissionsAsync).mockResolvedValueOnce({
      granted: true,
    } as never)

    await warmMicrophonePermission()

    await expect(ensureMicrophonePermission()).resolves.toBe(true)
    expect(getRecordingPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(requestRecordingPermissionsAsync).not.toHaveBeenCalled()
  })

  it('joins an in-flight warm-up when the mic is tapped immediately', async () => {
    let resolvePermission!: (value: { granted: boolean }) => void
    vi.mocked(getRecordingPermissionsAsync).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePermission = resolve
      }) as never,
    )

    const warmup = warmMicrophonePermission()
    const permission = ensureMicrophonePermission()
    resolvePermission({ granted: true })

    await expect(permission).resolves.toBe(true)
    await warmup
    expect(getRecordingPermissionsAsync).toHaveBeenCalledTimes(1)
    expect(requestRecordingPermissionsAsync).not.toHaveBeenCalled()
  })

  it('still requests permission when the read-only check is not granted', async () => {
    vi.mocked(getRecordingPermissionsAsync).mockResolvedValueOnce({
      granted: false,
    } as never)
    vi.mocked(requestRecordingPermissionsAsync).mockResolvedValueOnce({
      granted: true,
    } as never)

    await warmMicrophonePermission()

    await expect(ensureMicrophonePermission()).resolves.toBe(true)
    expect(requestRecordingPermissionsAsync).toHaveBeenCalledTimes(1)
  })
})
