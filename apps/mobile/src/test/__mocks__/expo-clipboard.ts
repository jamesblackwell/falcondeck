import { vi } from 'vitest'

export async function setStringAsync(_text: string) { return true }

export const getImageAsync = vi.fn(async () => null)

export const hasImageAsync = vi.fn(async () => false)
