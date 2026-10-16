import type {
  AgentProvider,
  SavedPrompt,
  SelectedSkillReference,
  SkillSourceKind,
  SkillSummary,
} from './types'

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

export type NativeSlashCommandId = 'goal' | 'compact'

export type NativeSlashCommand = {
  id: NativeSlashCommandId
  alias: string
  label: string
  description: string
}

/** Built-in composer commands, scored with the same ranker as skills. */
export const NATIVE_SLASH_COMMANDS: readonly NativeSlashCommand[] = [
  {
    id: 'goal',
    alias: '/goal',
    label: 'Goal',
    description: 'Set a goal to keep pursuing',
  },
  {
    id: 'compact',
    alias: '/compact',
    label: '/compact',
    description: 'Compact conversation history to free context',
  },
]

const NATIVE_SLASH_COMMAND_BY_ID = Object.fromEntries(
  NATIVE_SLASH_COMMANDS.map((command) => [command.id, command]),
) as Record<NativeSlashCommandId, NativeSlashCommand>

export type NativeSlashAvailability = {
  goal?: boolean
  compact?: boolean
}

export type SlashMatchSpan = {
  field: 'alias' | 'label' | 'description'
  /** Index into the displayed field string (alias includes a leading `/` when shown). */
  start: number
  length: number
}

type RankedSlashBase = {
  score: number
  match: SlashMatchSpan | null
}

export type RankedNativeSlashItem = RankedSlashBase & {
  kind: 'native'
  id: `native:${NativeSlashCommandId}`
  command: NativeSlashCommand
}

export type RankedSkillSlashItem = RankedSlashBase & {
  kind: 'skill'
  id: string
  skill: SkillSummary
}

export type RankedPromptSlashItem = RankedSlashBase & {
  kind: 'prompt'
  id: string
  prompt: SavedPrompt
}

export type RankedSlashItem =
  | RankedNativeSlashItem
  | RankedPromptSlashItem
  | RankedSkillSlashItem

/** Short source labels for slash-menu badges. */
export function slashSkillSourceLabel(kind: SkillSourceKind): string {
  switch (kind) {
    case 'project_file':
      return 'Project'
    case 'home_file':
      return 'User'
    case 'provider_native':
      return 'Built-in'
  }
}

function isWordCharCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122)
}

type FieldHit = {
  score: number
  start: number
  length: number
}

/**
 * Prefix and hyphen/word-boundary hits only. Mid-word substrings are noise
 * in a slash menu: `/fresh` must not select a skill whose description says
 * "refresh".
 */
function scoreField(query: string, original: string): FieldHit | null {
  if (!query || !original) return null
  const target = original.toLocaleLowerCase()
  let index = target.indexOf(query)
  if (index === -1) return null
  if (index === 0) {
    const leftover = target.length - query.length
    return {
      score: leftover === 0 ? 0 : 10 + Math.min(leftover, 40),
      start: 0,
      length: query.length,
    }
  }
  // Skip mid-word hits and keep scanning; "refresh the fresh draft" should
  // still match `/fresh` on the later word.
  while (index > 0 && isWordCharCode(target.charCodeAt(index - 1))) {
    index = target.indexOf(query, index + 1)
    if (index === -1) return null
  }
  return {
    score: 40 + Math.min(index, 40),
    start: index,
    length: query.length,
  }
}

const FIELD_WEIGHT = {
  alias: 0,
  label: 18,
  description: 64,
} as const

/**
 * Lower is better. Alias prefix beats alias word beats label beats a
 * description word; mid-word hits never count.
 */
export function scoreSlashFields(
  query: string,
  fields: { alias: string; label: string; description?: string | null },
): { score: number; match: SlashMatchSpan } | null {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return { score: 0, match: { field: 'alias', start: 0, length: 0 } }

  const aliasBare = canonicalSkillAlias(fields.alias).slice(1)
  const candidates: {
    field: SlashMatchSpan['field']
    hit: FieldHit
    weight: number
  }[] = []

  const aliasHit = scoreField(needle, aliasBare)
  if (aliasHit) {
    candidates.push({ field: 'alias', hit: aliasHit, weight: FIELD_WEIGHT.alias })
  }
  const labelHit = scoreField(needle, fields.label)
  if (labelHit) {
    candidates.push({ field: 'label', hit: labelHit, weight: FIELD_WEIGHT.label })
  }
  // One or two letters in a description ("c" in "current") is noise; alias
  // prefixes still match from the first character.
  if (fields.description && needle.length >= 3) {
    const descriptionHit = scoreField(needle, fields.description)
    if (descriptionHit) {
      candidates.push({
        field: 'description',
        hit: descriptionHit,
        weight: FIELD_WEIGHT.description,
      })
    }
  }
  if (candidates.length === 0) return null

  let best = candidates[0]!
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]!
    if (candidate.hit.score + candidate.weight < best.hit.score + best.weight) {
      best = candidate
    }
  }
  return {
    score: best.hit.score + best.weight,
    match: {
      field: best.field,
      start: best.hit.start,
      length: best.hit.length,
    },
  }
}

function mapAliasHighlight(
  displayedAlias: string,
  match: SlashMatchSpan | null,
): SlashMatchSpan | null {
  if (!match || match.field !== 'alias') return match
  if (displayedAlias.startsWith('/')) {
    return { ...match, start: match.start + 1 }
  }
  return match
}

function nativeSlashIds(native: NativeSlashAvailability): NativeSlashCommandId[] {
  const ids: NativeSlashCommandId[] = []
  if (native.goal) ids.push('goal')
  if (native.compact) ids.push('compact')
  return ids
}

function rankedNativeItem(
  id: NativeSlashCommandId,
  score: number,
  match: SlashMatchSpan | null,
): RankedNativeSlashItem {
  const command = NATIVE_SLASH_COMMAND_BY_ID[id]
  const aliasDisplay = id === 'goal' ? command.label : command.alias
  return {
    kind: 'native',
    id: `native:${id}`,
    command,
    score,
    match:
      match?.field === 'alias'
        ? mapAliasHighlight(aliasDisplay, match)
        : match,
  }
}

function rankedSkillItem(
  skill: SkillSummary,
  score: number,
  match: SlashMatchSpan | null,
): RankedSkillSlashItem {
  return {
    kind: 'skill',
    id: skill.id,
    skill,
    score,
    match: mapAliasHighlight(skill.alias, match),
  }
}

function rankedPromptItem(
  prompt: SavedPrompt,
  score: number,
  match: SlashMatchSpan | null,
): RankedPromptSlashItem {
  return {
    kind: 'prompt',
    id: prompt.id,
    prompt,
    score,
    match: mapAliasHighlight(prompt.alias, match),
  }
}

function slashItemSortKey(item: RankedSlashItem): string {
  if (item.kind === 'skill') return item.skill.alias
  if (item.kind === 'prompt') return item.prompt.alias
  return item.command.alias
}

/**
 * Ranked slash rows for the composer menu. Native commands and skills share
 * one list so a skill prefix can outrank a weaker built-in, and so `/fresh`
 * cannot lose to a description that merely contains "refresh".
 */
export function rankSlashSuggestions({
  skills,
  prompts = [],
  provider,
  query,
  native = {},
}: {
  skills: readonly SkillSummary[]
  prompts?: readonly SavedPrompt[]
  provider: AgentProvider
  query: string
  native?: NativeSlashAvailability
}): RankedSlashItem[] {
  const needle = query.trim().toLocaleLowerCase()
  const supported = skills.filter((skill) =>
    providerSupportsSkill(skill, provider),
  )
  const nativeIds = nativeSlashIds(native)
  const savedPrompts = [...prompts].sort((left, right) =>
    left.alias.localeCompare(right.alias),
  )

  if (!needle) {
    return [
      ...nativeIds.map((id) => rankedNativeItem(id, 0, null)),
      ...savedPrompts.map((prompt) => rankedPromptItem(prompt, 0, null)),
      ...[...supported]
        .sort((left, right) => left.alias.localeCompare(right.alias))
        .map((skill) => rankedSkillItem(skill, 0, null)),
    ]
  }

  const ranked: RankedSlashItem[] = []
  for (const id of nativeIds) {
    const command = NATIVE_SLASH_COMMAND_BY_ID[id]
    const scored = scoreSlashFields(needle, command)
    if (scored) ranked.push(rankedNativeItem(id, scored.score, scored.match))
  }
  for (const prompt of savedPrompts) {
    const scored = scoreSlashFields(needle, {
      alias: prompt.alias,
      label: prompt.label,
      description: prompt.description,
    })
    if (scored) ranked.push(rankedPromptItem(prompt, scored.score, scored.match))
  }
  for (const skill of supported) {
    const scored = scoreSlashFields(needle, {
      alias: skill.alias,
      label: skill.label,
      description: skill.description,
    })
    if (scored) ranked.push(rankedSkillItem(skill, scored.score, scored.match))
  }
  ranked.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score
    return slashItemSortKey(left).localeCompare(slashItemSortKey(right))
  })
  return ranked
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
  return rankSlashSuggestions({ skills, provider, query }).flatMap((item) =>
    item.kind === 'skill' ? [item.skill] : [],
  )
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

export function activeSlashQuery(
  value: string,
  caretIndex: number,
  promptAliases?: readonly string[],
): ActiveSlashQuery | null {
  if (caretIndex < 0 || caretIndex > value.length) return null

  const direct = slashQueryAtCaret(value, caretIndex)
  if (direct) return direct
  // A saved prompt can take words after its name (`/save-prompt the login`).
  // Skill mentions still close once the caret leaves the token, so Enter
  // keeps sending that draft.
  if (!promptAliases || promptAliases.length === 0) return null
  return promptArgumentQuery(value, caretIndex, promptAliases)
}

function slashQueryAtCaret(value: string, caretIndex: number): ActiveSlashQuery | null {
  let start = caretIndex
  while (start > 0 && !/\s/.test(value[start - 1] ?? '')) {
    start -= 1
  }

  if (value[start] !== '/') return null
  if (start > 0 && !/\s/.test(value[start - 1] ?? '')) return null

  const token = value.slice(start, caretIndex)
  if (!/^\/[A-Za-z0-9_-]*$/.test(token)) return null

  let rangeEnd = caretIndex
  while (rangeEnd < value.length && /[A-Za-z0-9_-]/.test(value[rangeEnd] ?? '')) {
    rangeEnd += 1
  }
  // A slash later in the same non-whitespace token makes this a path, not a
  // command mention. Punctuation is a valid token delimiter and stays put.
  if (value[rangeEnd] === '/') return null

  const rest = token.slice(1)
  return {
    query: rest.length === 0 ? '' : canonicalSkillAlias(token).slice(1),
    rangeStart: start,
    rangeEnd,
  }
}

/** Slash name on this line whose alias is a saved prompt, with the caret in its arguments. */
function promptArgumentQuery(
  value: string,
  caretIndex: number,
  promptAliases: readonly string[],
): ActiveSlashQuery | null {
  const aliases = new Set(promptAliases.map((alias) => canonicalSkillAlias(alias)))
  const lineStart = value.lastIndexOf('\n', caretIndex - 1) + 1
  let matchStart = -1
  let matchEnd = -1
  for (let index = lineStart; index < caretIndex; index += 1) {
    if (value[index] !== '/') continue
    if (index > lineStart && !/\s/.test(value[index - 1] ?? '')) continue
    let end = index + 1
    while (end < value.length && /[A-Za-z0-9_-]/.test(value[end] ?? '')) end += 1
    if (value[end] === '/' || end === index + 1 || end > caretIndex) continue
    const alias = canonicalSkillAlias(value.slice(index, end))
    if (!aliases.has(alias)) continue
    matchStart = index
    matchEnd = end
    index = end - 1
  }
  if (matchStart < 0) return null
  return {
    query: canonicalSkillAlias(value.slice(matchStart, matchEnd)).slice(1),
    rangeStart: matchStart,
    rangeEnd: matchEnd,
  }
}

/**
 * Fills `$ARGUMENTS` in a saved prompt. Text the user already typed after
 * the slash name is the argument string. With no placeholder, that text is
 * appended so it is not dropped on the floor.
 */
export function expandSavedPrompt(body: string, args: string): string {
  const trimmedArgs = args.trim()
  if (!body.includes('$ARGUMENTS')) {
    if (!trimmedArgs) return body
    const base = body.replace(/\s+$/, '')
    return base.length > 0 ? `${base}\n\n${trimmedArgs}` : trimmedArgs
  }
  const expanded = body.replaceAll('$ARGUMENTS', trimmedArgs)
  return trimmedArgs ? expanded : expanded.replace(/\s+$/g, '')
}

/** Replaces the slash token, and any arguments on its line, with the prompt body. */
export function savedPromptInsertion(
  value: string,
  query: ActiveSlashQuery,
  body: string,
): { value: string; caret: number } {
  let argEnd = query.rangeEnd
  while (argEnd < value.length && value[argEnd] !== '\n') argEnd += 1
  const expanded = expandSavedPrompt(body, value.slice(query.rangeEnd, argEnd))
  return {
    value: `${value.slice(0, query.rangeStart)}${expanded}${value.slice(argEnd)}`,
    caret: query.rangeStart + expanded.length,
  }
}
