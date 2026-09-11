import { vi } from 'vitest'

export const speak = vi.fn()
export const stop = vi.fn(async () => undefined)
export const pause = vi.fn(async () => undefined)
export const resume = vi.fn(async () => undefined)
