import type { AnalyticsAutomation, AnalyticsUsage, AnalyticsUsageRow } from '@falcondeck/client-core'
import { describe, expect, it } from 'vitest'

import { SETTINGS_NAV } from '../settings-utils'
import {
  ALL,
  ANALYTICS_SETTING_TABS,
  NO_SCHEDULED_FILTERS,
  NO_THREAD_FILTERS,
  agentLabel,
  compact,
  filterAutomations,
  filterOptions,
  filterThreads,
  groupTokens,
  modelLabel,
  scheduledOutcome,
  topBot,
  topModel,
} from './analytics-utils'

const totals = (tokens: number) => ({
  input_tokens: tokens,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  turns: 1,
  cost_usd: 0,
})

const usage = (bot: string | null, provider: string, model: string, tokens: number): AnalyticsUsage => ({
  bot,
  provider,
  model,
  totals: totals(tokens),
  cost_sources: [],
})

const automation = (patch: Partial<AnalyticsAutomation>): AnalyticsAutomation => ({
  name: 'Task',
  runs: 0,
  no_action: 0,
  failed: 0,
  skipped: 0,
  threads: 0,
  ...patch,
})

describe('compact', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [1000, '1k'],
    [7405, '7.4k'],
    [22323, '22k'],
    [999_600, '1M'],
    [1_230_000, '1.2M'],
    [340_000_000, '340M'],
    [999_900_000, '1B'],
    [1_200_000_000, '1.2B'],
    [12_400_000_000, '12B'],
  ])('%d is %s', (value, text) => expect(compact(value)).toBe(text))
})

describe('agent labels', () => {
  it.each([
    ['claude-haiku-5-5', 'Haiku 5.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-sonnet-5-5-20261001', 'Sonnet 5.5'],
    ['gpt-6.1-sol', 'GPT 6.1 Sol'],
    ['grok-4.7-build', 'Grok 4.7'],
    ['anthropic/claude-opus-5-5', 'Opus 5.5'],
  ])('%s reads %s', (model, label) => expect(modelLabel(model)).toBe(label))

  it('names the harness once', () => {
    expect(agentLabel('claude', 'claude-haiku-5-5')).toBe('Claude · Haiku 5.5')
    expect(agentLabel('codex', 'gpt-6.1-sol')).toBe('Codex · GPT 6.1 Sol')
    expect(agentLabel('grok', 'grok-4.7-build')).toBe('Grok 4.7')
    expect(agentLabel('claude', null)).toBe('Claude')
    expect(agentLabel(null, 'gpt-6.1')).toBe('GPT 6.1')
    expect(agentLabel(null, null)).toBe('Unknown')
  })
})

describe('token rollups', () => {
  const rows = [
    usage('Juno', 'claude', 'claude-haiku-5-5', 10),
    usage('Juno', 'codex', 'gpt-6.1-sol', 30),
    usage('Iris', 'claude', 'claude-haiku-5-5', 25),
    usage(null, 'claude', 'claude-opus-5-5', 100),
  ]

  it('groups by one dimension, busiest first', () => {
    expect(groupTokens(rows, 'all')).toHaveLength(4)
    expect(groupTokens(rows, 'harness').map((row) => [row.provider, row.totals.input_tokens])).toEqual([
      ['claude', 135],
      ['codex', 30],
    ])
    expect(groupTokens(rows, 'bot')[0]).toMatchObject({ bot: null, provider: '', model: '' })
  })

  it('finds the leaders; work with no bot is not a top bot', () => {
    expect(topBot(rows)).toEqual({ label: 'Juno', tokens: 40 })
    expect(topModel(rows)).toEqual({ label: 'Claude · Opus 5.5', tokens: 100 })
    expect(topBot([usage(null, 'claude', 'x', 1)])).toBeNull()
  })
})

describe('scheduled filters', () => {
  const tasks = [
    automation({ name: 'Inbox sweep', schedule: 'Hourly', state: 'enabled', agents: [{ provider: 'codex', model: 'gpt-6.1' }], bots: ['Juno'], flags: ['failing'] }),
    automation({ name: 'Digest', state: 'paused', provider: 'claude', flags: ['very_frequent'] }),
    automation({ name: 'Backup', state: 'completed', provider: 'claude' }),
  ]
  const names = (patch: Partial<typeof NO_SCHEDULED_FILTERS>) =>
    filterAutomations(tasks, { ...NO_SCHEDULED_FILTERS, ...patch }).map((task) => task.name)

  it('narrows by each filter', () => {
    expect(names({})).toEqual(['Inbox sweep', 'Digest', 'Backup'])
    expect(names({ query: 'hourly' })).toEqual(['Inbox sweep'])
    expect(names({ state: 'enabled' })).toEqual(['Inbox sweep'])
    expect(names({ state: 'paused' })).toEqual(['Digest'])
    expect(names({ failing: true })).toEqual(['Inbox sweep'])
    expect(names({ flagged: true })).toEqual(['Inbox sweep', 'Digest'])
    expect(names({ harness: 'claude' })).toEqual(['Digest', 'Backup'])
    expect(names({ bot: 'Juno' })).toEqual(['Inbox sweep'])
    expect(names({ flagged: true, harness: 'claude' })).toEqual(['Digest'])
  })

  it('does not reorder the summary it was given', () => {
    const before = tasks.map((task) => task.name)
    names({ sort: 'desc' })
    expect(tasks.map((task) => task.name)).toEqual(before)
  })

  it('counts nothing-to-do against runs that started', () => {
    expect(scheduledOutcome([automation({ runs: 10, skipped: 2, no_action: 4 })])).toEqual({ started: 8, noAction: 4 })
  })
})

describe('thread filters', () => {
  const row = (key: string, bot: string | null, provider: string, model: string): AnalyticsUsageRow => ({
    key,
    label: key,
    totals: totals(1),
    cost_sources: [],
    thread: { bot, workspace: 'w', project: 'p', origin: 'user', automation: null, provider, model },
  })
  const rows = [row('a', 'Juno', 'claude', 'haiku'), row('b', null, 'codex', 'gpt')]
  const keys = (patch: Partial<typeof NO_THREAD_FILTERS>) =>
    filterThreads(rows, { ...NO_THREAD_FILTERS, ...patch }).map((item) => item.key)

  it('narrows by bot, harness and model', () => {
    expect(keys({})).toEqual(['a', 'b'])
    expect(keys({ bot: 'Juno' })).toEqual(['a'])
    expect(keys({ bot: 'No bot' })).toEqual(['b'])
    expect(keys({ harness: 'codex' })).toEqual(['b'])
    expect(keys({ model: 'haiku' })).toEqual(['a'])
  })
})

describe('filterOptions', () => {
  it('keeps a selected value that left the data', () => {
    expect(filterOptions(['b', 'a', 'a', ''], ALL).map((option) => option.value)).toEqual(['a', 'b'])
    expect(filterOptions(['a'], 'gone').map((option) => option.value)).toEqual(['a', 'gone'])
  })
})

it('maps every searchable analytics title to a tab', () => {
  const section = SETTINGS_NAV.find((item) => item.id === 'analytics')!
  expect(section.settings.filter((title) => !ANALYTICS_SETTING_TABS[title])).toEqual([])
})
