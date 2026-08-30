import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio'

let permissionGranted = false
let permissionChecked = false
let permissionEpoch = 0
let permissionProbe: Promise<boolean> | null = null
let permissionRequest: Promise<boolean> | null = null

/**
 * Reads the existing microphone permission while the composer is idle. This
 * never prompts, but lets the common already-authorized path skip a native
 * bridge round trip after the user taps the mic.
 */
export async function warmMicrophonePermission(): Promise<void> {
  if (permissionChecked || permissionProbe) {
    await permissionProbe
    return
  }

  const epoch = permissionEpoch
  const probe = getRecordingPermissionsAsync()
    .then((permission) => {
      if (epoch === permissionEpoch) {
        permissionChecked = true
        permissionGranted = permission.granted
      }
      return permission.granted
    })
    .catch(() => false)
  permissionProbe = probe

  try {
    await probe
  } finally {
    if (permissionProbe === probe) permissionProbe = null
  }
}

/** Returns promptly after a successful warm-up; prompts only when necessary. */
export async function ensureMicrophonePermission(): Promise<boolean> {
  if (permissionGranted) return true
  if (permissionProbe) await permissionProbe
  if (permissionGranted) return true
  if (permissionRequest) return permissionRequest

  const epoch = permissionEpoch
  const request = requestRecordingPermissionsAsync().then((permission) => {
    if (epoch === permissionEpoch) {
      permissionChecked = true
      permissionGranted = permission.granted
    }
    return permission.granted
  })
  permissionRequest = request

  try {
    return await request
  } finally {
    if (permissionRequest === request) permissionRequest = null
  }
}

/** Clears a possibly stale grant after a native permission-related failure. */
export function invalidateMicrophonePermissionCache(): void {
  permissionEpoch += 1
  permissionGranted = false
  permissionChecked = false
  permissionProbe = null
  permissionRequest = null
}
