// In-memory MMKV mock for tests
const stores = new Map<string, Map<string, string>>()

export class MMKV {
  private store: Map<string, string>

  constructor(opts?: { id?: string }) {
    const id = opts?.id ?? 'default'
    if (!stores.has(id)) stores.set(id, new Map())
    this.store = stores.get(id)!
  }

  getString(key: string): string | undefined {
    return this.store.get(key)
  }

  getNumber(key: string): number | undefined {
    const v = this.store.get(key)
    return v !== undefined ? Number(v) : undefined
  }

  getBoolean(key: string): boolean | undefined {
    const v = this.store.get(key)
    if (v === undefined) return undefined
    return v === 'true'
  }

  set(key: string, value: string | number | boolean): void {
    this.store.set(key, String(value))
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  clearAll(): void {
    this.store.clear()
  }
}

// Reset all stores between tests — clears contents not references
export function __resetAllStores() {
  for (const store of stores.values()) {
    store.clear()
  }
}
