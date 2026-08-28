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
  // The open providers list is authoritative; the availability lattice only
  // covers payloads from daemons that predate it.
  if (skill.providers && skill.providers.length > 0) {
    return skill.providers.includes(provider)
  }
  return skill.availability === 'both' || skill.availability === provider
}

/** Last live slash-menu fetch, keyed so a provider switch cannot reuse it. */
export type LiveSkillCatalog = {
  workspaceId: string
  provider: AgentProvider
  skills: SkillSummary[]
}

/** Catalog used when submitting `/alias` mentions. Prefers a matching live fetch. */
export function composerSkillCatalog(
  live: LiveSkillCatalog | null,
  workspace: { id: string; skills?: SkillSummary[] } | null | undefined,
  provider: AgentProvider,
): SkillSummary[] {
  if (
    live &&
    workspace &&
    live.workspaceId === workspace.id &&
    live.provider === provider
  ) {
    return live.skills
  }
  return workspace?.skills ?? []
}

/**
 * Provider-scoped slash rows. Unsupported skills are omitted rather than
 * shown greyed; the query only filters, it does not refetch.
 */
export function filterSlashSkills(
  skills: SkillSummary[],
  provider: AgentProvider,
  query: string,
): SkillSummary[] {
  const needle = query.trim().toLowerCase()
  return skills
    .filter((skill) => providerSupportsSkill(skill, provider))
    .filter((skill) => {
      if (!needle) return true
      return (
        canonicalSkillAlias(skill.alias).includes(`/${needle}`) ||
        skill.label.toLowerCase().includes(needle) ||
        (skill.description ?? '').toLowerCase().includes(needle)
      )
    })
    .sort((left, right) => left.alias.localeCompare(right.alias))
}

/**
 * A slash-command mention: preceded by start-of-text or whitespace, a `/`
 * followed by a word, and not a path segment (`/api/provider` never matches).
 * The lookahead forbids every token character plus `/`, so the engine cannot
 * backtrack into matching `/ap` out of `/api/provider`. Shared by composer
 * skill detection and transcript command highlighting so what lights up in a
 * sent message is exactly what the composer treated as a command mention.
 */
const SLASH_COMMAND_MENTION = /(^|\s)(\/[A-Za-z0-9_-]+)(?![A-Za-z0-9_/-])/g

export type SlashCommandSegment = {
  kind: 'text' | 'command'
  value: string
}

/** Splits plain text into ordinary runs and slash-command mentions. */
export function splitSlashCommandSegments(text: string): SlashCommandSegment[] {
  const segments: SlashCommandSegment[] = []
  let cursor = 0

  for (const match of text.matchAll(SLASH_COMMAND_MENTION)) {
    const commandStart = (match.index ?? 0) + match[1].length
    const command = match[2]
    if (commandStart > cursor) {
      segments.push({ kind: 'text', value: text.slice(cursor, commandStart) })
    }
    segments.push({ kind: 'command', value: command })
    cursor = commandStart + command.length
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', value: text.slice(cursor) })
  }
  return segments
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

  for (const match of value.matchAll(SLASH_COMMAND_MENTION)) {
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

  const rest = token.slice(1)
  return {
    query: rest.length === 0 ? '' : canonicalSkillAlias(token).slice(1),
    rangeStart: start,
    rangeEnd: caretIndex,
  }
}
