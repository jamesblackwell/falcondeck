/** Long option lists become searchable; shorter menus stay visually quiet. */
export const SEARCHABLE_OPTION_THRESHOLD = 8

export function filterOptionsByQuery<T>(
  options: readonly T[],
  query: string,
  searchableText: (option: T) => string,
): T[] {
  const tokens = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  if (tokens.length === 0) return [...options]

  return options.filter((option) => {
    const haystack = searchableText(option).toLocaleLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}
