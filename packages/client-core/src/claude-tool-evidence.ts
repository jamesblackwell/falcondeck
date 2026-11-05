/** Claude's edit result uses jsdiff hunks, not a ready-to-render patch string. */
export function claudeEditDiff(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const hunks = (result as { structuredPatch?: unknown }).structuredPatch
  if (!Array.isArray(hunks)) return null
  const rendered = hunks.flatMap(hunk => {
    if (!hunk || typeof hunk !== 'object' || !Array.isArray(hunk.lines) ||
      ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(Number.isFinite) ||
      !hunk.lines.every((line: unknown) => typeof line === 'string')) return []
    return [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`]
  })
  return rendered.length ? rendered.join('\n') : null
}
