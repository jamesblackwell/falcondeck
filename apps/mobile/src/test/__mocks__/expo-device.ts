// Stub expo-device for tests
export let isDevice: boolean = true
export function __setIsDevice(next: boolean) {
  isDevice = next
}
export const deviceName: string | null = null
export const modelName: string | null = 'iPhone 15'
export const osName: string | null = 'iOS'
export const osVersion: string | null = '18.0'
