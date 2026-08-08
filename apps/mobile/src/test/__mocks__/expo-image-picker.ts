import { vi } from 'vitest'

export const requestMediaLibraryPermissionsAsync = vi.fn(async () => ({
  granted: true,
  accessPrivileges: 'all' as const,
}))

export const launchImageLibraryAsync = vi.fn(async () => ({
  canceled: true as const,
  assets: null,
}))

export const requestCameraPermissionsAsync = vi.fn(async () => ({
  granted: true,
}))

export const launchCameraAsync = vi.fn(async () => ({
  canceled: true as const,
  assets: null,
}))
