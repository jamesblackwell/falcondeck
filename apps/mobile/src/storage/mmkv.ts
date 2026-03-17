import { MMKV } from 'react-native-mmkv'
import type { StateStorage } from 'zustand/middleware'

export const storage = new MMKV({ id: 'falcondeck-mobile' })

export function getJson<T>(key: string): T | null {
  const raw = storage.getString(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function setJson(key: string, value: unknown): void {
  storage.set(key, JSON.stringify(value))
}

export function removeKey(key: string): void {
  storage.delete(key)
}

/** Zustand persist middleware adapter */
export const mmkvStorage: StateStorage = {
  getItem: (name) => storage.getString(name) ?? null,
  setItem: (name, value) => storage.set(name, value),
  removeItem: (name) => storage.delete(name),
}
