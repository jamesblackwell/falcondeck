import {
  defaultProviderLabel,
  type AnalyticsAgent,
  type AnalyticsAutomation,
  type AnalyticsRebuildCause,
  type AnalyticsWasteItem,
  type AnalyticsWasteRule,
  type AnalyticsUsage,
  type AnalyticsUsageRow,
  type AnalyticsUsageTotals,
} from '@falcondeck/client-core'

export type AnalyticsTab = 'waste' | 'cache' | 'overview' | 'tokens' | 'threads' | 'scheduled' | 'activity' | 'messages' | 'recording'

export const ANALYTICS_TABS: Array<{ value: AnalyticsTab; label: string }> = [
  { value: 'waste', label: 'Waste' },
  { value: 'cache', label: 'Cache' },
  { value: 'overview', label: 'Overview' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'threads', label: 'Threads' },
  { value: 'scheduled', label: 'Scheduled tasks' },
  { value: 'activity', label: 'Activity' },
  { value: 'messages', label: 'Messages' },
  { value: 'recording', label: 'Recording' },
]

/** Deep-link targets, by the on-page title Settings search jumps to. Every
 * analytics title in settings-utils must be listed so its tab can open first. */
export const ANALYTICS_SETTING_TABS: Record<string, AnalyticsTab> = {
  Waste: 'waste',
  'Ranked offenders': 'waste',
  'How flags are decided': 'waste',
  Cache: 'cache',
  'Cache hit rate': 'cache',
  'Where input cost goes': 'cache',
  'Cache rebuilds': 'cache',
  'Home threads': 'cache',
  'Added to each bot turn': 'cache',
  Overview: 'overview',
  Tokens: 'tokens',
  'Token usage': 'tokens',
  'Turns by bot': 'tokens',
  'Turns by harness': 'tokens',
  Threads: 'threads',
  'Top threads': 'threads',
  'Scheduled tasks': 'scheduled',
  Activity: 'activity',
  'Who drives the work': 'activity',
  'Waiting on you': 'activity',
  'Agent communication': 'activity',
  'Files agents write': 'activity',
  Messages: 'messages',
  'Your messages': 'messages',
  Recording: 'recording',
  'Record activity': 'recording',
  'Record token usage': 'recording',
  'Keep your messages': 'recording',
  'Keep activity for': 'recording',
  Storage: 'recording',
}

const TAB_STORAGE_KEY = 'falcondeck.settings.analytics.tab'

export function readStoredTab(): AnalyticsTab {
  try {
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY)
    return ANALYTICS_TABS.find((tab) => tab.value === stored)?.value ?? 'waste'
  } catch {
    return 'waste'
  }
}

export function storeTab(tab: AnalyticsTab) {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab)
  } catch {
    // The choice just isn't remembered.
  }
}

export const count = (value: number) => value.toLocaleString()

const UNITS: Array<[number, string]> = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
]

/** 950, 7.4k, 22k, 1.2M, 340M, 1.2B. */
export function compact(value: number) {
  for (const [size, unit] of UNITS) {
    const scaled = value / size
    if (scaled < 1) continue
    const text = scaled.toFixed(scaled < 10 ? 1 : 0).replace(/\.0$/, '')
    // Rounding can reach the next unit: 999,600 is 1M, not 1000k.
    if (text === '1000' && unit !== 'B') return `1${unit === 'k' ? 'M' : 'B'}`
    return `${text}${unit}`
  }
  return String(Math.round(value))
}

export function duration(ms: number) {
  if (!ms) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function bytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function when(at: string) {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function shortDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function percent(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : '0%'
}

/** Provider-reported API-equivalent cost; small figures keep precision. */
export function usd(value: number) {
  if (!value) return '—'
  return `$${value >= 1 ? value.toFixed(2) : value.toFixed(4)}`
}

export function costTitle(sources: string[] | undefined) {
  return sources?.includes('provider_unverified')
    ? 'Provider-reported; the cost unit is unverified'
    : 'Provider-reported list-price API equivalent'
}

export function tokenTotal(usage?: AnalyticsUsageTotals) {
  return usage ? usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens + usage.output_tokens : 0
}

function addTotals(sum: AnalyticsUsageTotals, next: AnalyticsUsageTotals): AnalyticsUsageTotals {
  return {
    input_tokens: sum.input_tokens + next.input_tokens,
    cache_read_tokens: sum.cache_read_tokens + next.cache_read_tokens,
    cache_write_tokens: sum.cache_write_tokens + next.cache_write_tokens,
    output_tokens: sum.output_tokens + next.output_tokens,
    turns: sum.turns + next.turns,
    cost_usd: sum.cost_usd + next.cost_usd,
  }
}

const NO_TOTALS: AnalyticsUsageTotals = {
  input_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  turns: 0,
  cost_usd: 0,
}

/** "claude-haiku-5-5" to "Haiku 5.5", "gpt-6.1-sol" to "GPT 6.1 Sol". */
export function modelLabel(model: string) {
  return (model.split('/').at(-1) ?? model)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-build$/, '')
    .replace(/-(\d+)-(\d+)(?=-|$)/, '-$1.$2')
    .split('-')
    .map((word) => (word === 'gpt' ? 'GPT' : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

export const harnessLabel = (provider: string) => defaultProviderLabel(provider)

/** "Claude · Haiku 5.5", or just "Grok 4.7" when the model names the harness. */
export function agentLabel(provider?: string | null, model?: string | null) {
  const harness = provider ? harnessLabel(provider) : ''
  const name = model ? modelLabel(model) : ''
  if (!name) return harness || 'Unknown'
  return !harness || name.toLowerCase().startsWith(harness.toLowerCase()) ? name : `${harness} · ${name}`
}

export type FilterOption = { value: string; label: string }

/** Distinct values for a filter menu; the current choice stays listed so a
 * period change cannot strand a filter with no way to see what it is. */
export function filterOptions(values: string[], selected: string, label: (value: string) => string = (value) => value): FilterOption[] {
  const distinct = new Set(values.filter(Boolean))
  if (selected !== ALL) distinct.add(selected)
  return [...distinct].sort((a, b) => label(a).localeCompare(label(b))).map((value) => ({ value, label: label(value) }))
}

export const ALL = 'all'
export const NO_BOT = 'No bot'

export type TokenGroup = 'all' | 'bot' | 'harness' | 'model'

export type TokenRow = {
  key: string
  bot: string | null
  provider: string
  model: string
  totals: AnalyticsUsageTotals
  cost_sources: string[]
}

/** Rolls the bot × harness × model rows up one dimension, busiest first. */
export function groupTokens(rows: AnalyticsUsage[], group: TokenGroup): TokenRow[] {
  const grouped = new Map<string, TokenRow>()
  for (const row of rows) {
    const bot = group === 'all' || group === 'bot' ? row.bot : null
    const provider = group === 'bot' ? '' : row.provider
    const model = group === 'all' || group === 'model' ? row.model : ''
    const key = JSON.stringify([bot, provider, model])
    const current = grouped.get(key)
    grouped.set(key, {
      key,
      bot,
      provider,
      model,
      totals: addTotals(current?.totals ?? NO_TOTALS, row.totals),
      cost_sources: [...new Set([...(current?.cost_sources ?? []), ...(row.cost_sources ?? [])])],
    })
  }
  return [...grouped.values()].sort((a, b) => tokenTotal(b.totals) - tokenTotal(a.totals))
}

export function automationAgents(automation: AnalyticsAutomation): AnalyticsAgent[] {
  return automation.agents ?? []
}

/** Pool of harnesses behind a task: what ran, and what it is set to run on. */
export function automationHarnesses(automation: AnalyticsAutomation) {
  const observed = automationAgents(automation).map((agent) => agent.provider)
  return automation.provider ? [...observed, automation.provider] : observed
}

export type ScheduledFilters = {
  query: string
  state: 'all' | 'enabled' | 'paused'
  failing: boolean
  flagged: boolean
  harness: string
  bot: string
  sort: 'desc' | 'asc' | null
}

export const NO_SCHEDULED_FILTERS: ScheduledFilters = {
  query: '',
  state: 'all',
  failing: false,
  flagged: false,
  harness: ALL,
  bot: ALL,
  sort: null,
}

export function scheduledFiltersActive(filters: ScheduledFilters) {
  return (
    Boolean(filters.query.trim()) ||
    filters.state !== 'all' ||
    filters.failing ||
    filters.flagged ||
    filters.harness !== ALL ||
    filters.bot !== ALL
  )
}

export function filterAutomations(automations: AnalyticsAutomation[], filters: ScheduledFilters) {
  const query = filters.query.trim().toLowerCase()
  const kept = automations.filter((automation) => {
    if (query && !`${automation.name} ${automation.schedule ?? ''}`.toLowerCase().includes(query)) return false
    if (filters.state !== 'all' && automation.state !== filters.state) return false
    if (filters.failing && !automation.flags?.includes('failing')) return false
    if (filters.flagged && !automation.flags?.length) return false
    if (filters.harness !== ALL && !automationHarnesses(automation).includes(filters.harness)) return false
    if (filters.bot !== ALL && !(automation.bots ?? []).includes(filters.bot)) return false
    return true
  })
  if (!filters.sort) return kept
  const direction = filters.sort === 'desc' ? -1 : 1
  return kept.sort((a, b) => direction * (tokenTotal(a.usage) - tokenTotal(b.usage)))
}

export type ThreadFilters = { bot: string; harness: string; model: string }

export const NO_THREAD_FILTERS: ThreadFilters = { bot: ALL, harness: ALL, model: ALL }

export const threadBot = (row: AnalyticsUsageRow) => row.thread?.bot ?? NO_BOT

export function filterThreads(rows: AnalyticsUsageRow[], filters: ThreadFilters) {
  return rows.filter(
    (row) =>
      (filters.bot === ALL || threadBot(row) === filters.bot) &&
      (filters.harness === ALL || row.thread?.provider === filters.harness) &&
      (filters.model === ALL || row.thread?.model === filters.model),
  )
}

export type Leader = { label: string; tokens: number }

/** The biggest group among already-filtered rollup rows. */
function leader(rows: TokenRow[], label: (row: TokenRow) => string): Leader | null {
  const top = rows[0]
  return top ? { label: label(top), tokens: tokenTotal(top.totals) } : null
}

export function topBot(rows: AnalyticsUsage[]) {
  return leader(groupTokens(rows.filter((row) => row.bot), 'bot'), (row) => row.bot ?? NO_BOT)
}

export function topModel(rows: AnalyticsUsage[]) {
  return leader(groupTokens(rows, 'model'), (row) => agentLabel(row.provider, row.model))
}

/** Runs that found nothing to do, out of the runs that actually started. */
export function scheduledOutcome(automations: AnalyticsAutomation[]) {
  return automations.reduce(
    (sum, automation) => ({
      started: sum.started + automation.runs - automation.skipped,
      noAction: sum.noAction + automation.no_action,
    }),
    { started: 0, noAction: 0 },
  )
}

/** Estimated dollars: always marked, so nobody reads them as a bill. */
export function estimate(value: number) {
  if (!value) return '—'
  return `≈$${value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(2)}`
}

export const WASTE_GROUPS = [
  { value: 'all', label: 'All' },
  { value: 'cache', label: 'Cache breaks' },
  { value: 'result', label: 'Little result' },
  { value: 'bloat', label: 'Bloat' },
] as const

export type WasteGroup = (typeof WASTE_GROUPS)[number]['value']

export function filterWaste(items: AnalyticsWasteItem[], group: WasteGroup) {
  return group === 'all' ? items : items.filter((item) => item.group === group)
}

/** Totals from the rules, which cover everything `report.waste` is capped to. */
export function ruleTotals(rules: AnalyticsWasteRule[], group: WasteGroup = 'all') {
  return rules
    .filter((rule) => group === 'all' || rule.group === group)
    .reduce(
      (sum, rule) => ({ flagged: sum.flagged + (rule.flagged ?? 0), usd: sum.usd + (rule.estimated_usd ?? 0) }),
      { flagged: 0, usd: 0 },
    )
}

export const CAUSES: Record<string, { label: string; detail: string }> = {
  idle_gap: { label: 'Idle past the TTL', detail: 'Over 60 minutes since the last turn, so the cache had expired.' },
  first_turn: { label: 'First turn', detail: 'A new thread has nothing to read yet. The price of starting.' },
  model_switch: { label: 'Model switch', detail: 'Caches belong to one model.' },
  effort_switch: { label: 'Effort switch', detail: 'Changing effort invalidates the message cache.' },
  compaction: { label: 'Compaction', detail: 'Recorded from this build on.' },
  prefix_change: { label: 'Prefix change', detail: 'The first call missed a warm cache on the same model and effort. The cause is not on record.' },
  possible_prefix_change: {
    label: 'Possible prefix change',
    detail: 'A large rewrite while warm. The records cannot rule out a switch or a compaction.',
  },
  unclear: { label: "Can't tell", detail: 'A large write sub-agents or a compaction could equally explain.' },
  input_after_gap: {
    label: 'New input after a gap',
    detail: 'This provider reports no writes, so a rebuild and new input look the same.',
  },
}

export function causeLabel(cause: string) {
  return CAUSES[cause]?.label ?? cause
}

/** Costliest first, with first turns last: they are not a fault. */
export function rankCauses(rows: AnalyticsRebuildCause[]) {
  return [...rows].sort((a, b) => Number(a.cause === 'first_turn') - Number(b.cause === 'first_turn') || b.estimated_usd - a.estimated_usd)
}

export function gapLabel(minutes?: number | null) {
  if (minutes === null || minutes === undefined) return '—'
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`
}
