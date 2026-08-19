/**
 * Device-local starring for the model picker. Starred ids keep their own
 * order (most recently starred first); the rest of the roster stays as the
 * provider advertised it.
 */

export const MAX_STARRED_MODELS = 100

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/** Parses a stored id list, dropping blanks and duplicates while keeping order. */
export function parseStarredModelIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const ids: string[] = []
    const seen = new Set<string>()
    for (const entry of parsed) {
      if (!isNonEmptyString(entry)) continue
      const id = entry.trim()
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      if (ids.length >= MAX_STARRED_MODELS) break
    }
    return ids
  } catch {
    return []
  }
}

/**
 * Stars an id by moving it to the front, or removes it when already starred.
 * Existing relative order of the other starred ids is unchanged.
 */
export function toggleStarredModelId(
  starredIds: readonly string[],
  modelId: string,
): string[] {
  const id = modelId.trim()
  if (!id) return [...starredIds]
  if (starredIds.includes(id)) {
    return starredIds.filter((existing) => existing !== id)
  }
  return [id, ...starredIds.filter((existing) => existing !== id)].slice(
    0,
    MAX_STARRED_MODELS,
  )
}

/** Starred models first (in starred order), then the remaining original order. */
export function sortModelsByStarred<T extends { id: string }>(
  models: readonly T[],
  starredIds: readonly string[],
): T[] {
  if (starredIds.length === 0 || models.length === 0) return [...models]
  const rank = new Map(starredIds.map((id, index) => [id, index]))
  const starred: T[] = []
  const rest: T[] = []
  for (const model of models) {
    if (rank.has(model.id)) starred.push(model)
    else rest.push(model)
  }
  starred.sort(
    (left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0),
  );
  return [...starred, ...rest]
}
