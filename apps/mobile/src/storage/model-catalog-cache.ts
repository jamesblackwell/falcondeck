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

function loadCache(): ModelCatalogCache {
  if (cache) return cache
  const stored = getJson<ModelCatalogCache>(MODEL_CATALOG_CACHE_KEY)
  cache =
    stored && stored.version === MODEL_CATALOG_CACHE_VERSION
      ? stored
      : { version: MODEL_CATALOG_CACHE_VERSION, entries: {} }
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
  current.entries[key] = models
  setJson(MODEL_CATALOG_CACHE_KEY, current)
}
