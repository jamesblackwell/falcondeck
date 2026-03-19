import type { AgentProvider, SelectedSkillReference, SkillSummary } from './types'

export function canonicalSkillAlias(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/^[/$]+/, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-|-$/g, '')

  return normalized.length > 0 ? `/${normalized}` : '/skill'
}

export function providerSupportsSkill(skill: SkillSummary, provider: AgentProvider): boolean {
  return skill.availability === 'both' || skill.availability === provider
}

export function selectedSkillsFromText(
  value: string,
  skills: SkillSummary[],
): SelectedSkillReference[] {
  if (!value.trim()) return []

  const byAlias = new Map(
    skills.map((skill) => [canonicalSkillAlias(skill.alias), skill] as const),
  )
  const seen = new Set<string>()
  const selections: SelectedSkillReference[] = []

  for (const match of value.matchAll(/(^|\s)(\/[A-Za-z0-9_-]+)(?!\/)/g)) {
    const alias = canonicalSkillAlias(match[2] ?? '')
    const skill = byAlias.get(alias)
    if (!skill || seen.has(skill.id)) continue
    seen.add(skill.id)
    selections.push({ skill_id: skill.id, alias: skill.alias })
  }

  return selections
}

export type ActiveSlashQuery = {
  query: string
  rangeStart: number
  rangeEnd: number
}

export function activeSlashQuery(value: string, caretIndex: number): ActiveSlashQuery | null {
  if (caretIndex < 0 || caretIndex > value.length) return null

  let start = caretIndex
  while (start > 0 && !/\s/.test(value[start - 1] ?? '')) {
    start -= 1
  }

  if (value[start] !== '/') return null
  if (start > 0 && !/\s/.test(value[start - 1] ?? '')) return null

  const token = value.slice(start, caretIndex)
  if (token.length === 0 || /\s/.test(token) || token.slice(1).includes('/')) return null

  return {
    query: canonicalSkillAlias(token).slice(1),
    rangeStart: start,
    rangeEnd: caretIndex,
  }
}
