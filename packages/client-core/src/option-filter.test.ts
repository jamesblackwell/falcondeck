import { describe, expect, it } from 'vitest'

import {
  filterOptionsByQuery,
  SEARCHABLE_OPTION_THRESHOLD,
} from './option-filter'

const options = [
  { id: 'openrouter/amazon:nova-lite', label: 'Amazon Nova Lite' },
  { id: 'openrouter/moonshotai:kimi-k2.6', label: 'Kimi K2.6' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
]

describe('option filtering', () => {
  it('uses one consistent long-list threshold', () => {
    expect(SEARCHABLE_OPTION_THRESHOLD).toBe(8)
  })

  it('matches case-insensitive tokens across labels and identifiers', () => {
    expect(
      filterOptionsByQuery(
        options,
        'OPENROUTER nova',
        (option) => `${option.label} ${option.id}`,
      ),
    ).toEqual([options[0]])
  })

  it('returns all options for a whitespace-only query without mutating input', () => {
    const result = filterOptionsByQuery(options, '   ', (option) => option.label)
    expect(result).toEqual(options)
    expect(result).not.toBe(options)
  })
})
