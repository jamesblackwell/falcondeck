import type { ConversationItem } from '@falcondeck/client-core'

const sizes = new WeakMap<ConversationItem, number>()

/** Estimate retained bytes without allocating a serialized copy of large output. */
export function conversationItemBytes(item: ConversationItem): number {
  const cached = sizes.get(item)
  if (cached !== undefined) return cached
  const seen = new WeakSet<object>()
  function measure(value: unknown): number {
    if (typeof value === 'string') return value.length * 2
    if (!value || typeof value !== 'object') return 8
    if (seen.has(value)) return 0
    seen.add(value)
    return Object.entries(value).reduce(
      (total, [key, child]) => total + key.length * 2 + 8 + measure(child), 32,
    )
  }
  const bytes = measure(item)
  sizes.set(item, bytes)
  return bytes
}
