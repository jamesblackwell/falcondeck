import type { ModelSummary } from '@falcondeck/client-core'

import { getJson, setJson } from './mmkv'

// Model catalogs change rarely (harness upgrades, plan changes), so the last
// known list per workspace+provider is cached device-locally and shown while
// the live catalog hydrates. Fresh non-empty lists from the daemon always
// overwrite the cache; stale entries are only a stopgap.
const MODEL_CATALOG_CACHE_KEY = 'mobile.model-catalog-cache'
const MODEL_CATALOG_CACHE_VERSION = 1

type ModelCatalogCache = {
  version: number
  entries: Record<string, ModelSummary[]>
}

let cache: ModelCatalogCache | null = null

function isModelSummary(value: unknown): value is ModelSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const model = value as Record<string, unknown>
  return (
    typeof model.id === 'string' &&
    typeof model.label === 'string' &&
    typeof model.is_default === 'boolean' &&
    (model.default_reasoning_effort === null ||
      typeof model.default_reasoning_effort === 'string') &&
    Array.isArray(model.supported_reasoning_efforts) &&
    model.supported_reasoning_efforts.every(
      (effort) =>
        typeof effort === 'object' &&
        effort !== null &&
        typeof (effort as { reasoning_effort?: unknown }).reasoning_effort ===
          'string',
    ) &&
    (model.service_tiers === undefined ||
      (Array.isArray(model.service_tiers) &&
        model.service_tiers.every(
          (tier) =>
            typeof tier === 'object' &&
            tier !== null &&
            typeof (tier as { id?: unknown }).id === 'string' &&
            typeof (tier as { name?: unknown }).name === 'string' &&
            typeof (tier as { description?: unknown }).description === 'string',
        )))
  )
}

function normalizeStoredCache(value: unknown): ModelCatalogCache {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { version: MODEL_CATALOG_CACHE_VERSION, entries: {} }
  }
  const stored = value as Record<string, unknown>
  if (
    stored.version !== MODEL_CATALOG_CACHE_VERSION ||
    typeof stored.entries !== 'object' ||
    stored.entries === null ||
    Array.isArray(stored.entries)
  ) {
    return { version: MODEL_CATALOG_CACHE_VERSION, entries: {} }
  }
  const entries = Object.fromEntries(
    Object.entries(stored.entries).flatMap(([key, models]) =>
      Array.isArray(models) && models.every(isModelSummary)
        ? [[key, models]]
        : [],
    ),
  )
  return { version: MODEL_CATALOG_CACHE_VERSION, entries }
}

function loadCache(): ModelCatalogCache {
  if (cache) return cache
  cache = normalizeStoredCache(getJson<unknown>(MODEL_CATALOG_CACHE_KEY))
  return cache
}

function catalogKey(workspaceId: string, provider: string): string {
  return `${workspaceId}:${provider}`
}

export function loadCachedModels(
  workspaceId: string,
  provider: string,
): ModelSummary[] {
  return loadCache().entries[catalogKey(workspaceId, provider)] ?? []
}

export function persistCachedModels(
  workspaceId: string,
  provider: string,
  models: ModelSummary[],
): void {
  const current = loadCache()
  const key = catalogKey(workspaceId, provider)
  if (current.entries[key] === models) return
  // The caller's list identity churns with every snapshot update even when
  // the catalog itself is unchanged; compare content before paying for a
  // full-cache MMKV write.
  const serialized = JSON.stringify(models)
  const existing = current.entries[key]
  if (existing && JSON.stringify(existing) === serialized) {
    current.entries[key] = models
    return
  }
  current.entries[key] = models
  setJson(MODEL_CATALOG_CACHE_KEY, current)
}
