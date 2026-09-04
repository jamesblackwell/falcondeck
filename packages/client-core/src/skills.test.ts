import { describe, expect, it } from 'vitest'

import {
  activeSlashQuery,
  composerSkillCatalog,
  filterSlashSkills,
  rankSlashSuggestions,
  scoreSlashFields,
  slashSkillSourceLabel,
  splitSlashCommandSegments,
} from './skills'
import type { SkillSummary } from './types'

const lintSkill: SkillSummary = {
  id: 'skill:lint',
  label: 'Lint',
  alias: '/lint',
  availability: 'both',
  providers: ['codex', 'claude'],
  source_kind: 'project_file',
  description: 'Run lint fixes',
}

const grokSkill: SkillSummary = {
  id: 'skill:grok-review',
  label: 'Grok Review',
  alias: '/grok-review',
  availability: 'both',
  providers: ['grok'],
  source_kind: 'project_file',
}

describe('splitSlashCommandSegments', () => {
  it('splits a trailing command on its own line', () => {
    expect(
      splitSlashCommandSegments('What is the evidence?\n\n/db-query'),
    ).toEqual([
      { kind: 'text', value: 'What is the evidence?\n\n' },
      { kind: 'command', value: '/db-query' },
    ])
  })

  it('finds commands mid-sentence after whitespace', () => {
    expect(splitSlashCommandSegments('please run /deslop now')).toEqual([
      { kind: 'text', value: 'please run ' },
      { kind: 'command', value: '/deslop' },
      { kind: 'text', value: ' now' },
    ])
  })

  it('matches a command that is the entire text', () => {
    expect(splitSlashCommandSegments('/code-review')).toEqual([
      { kind: 'command', value: '/code-review' },
    ])
  })

  it('ignores path segments and words attached to other text', () => {
    expect(
      splitSlashCommandSegments('check /api/provider and either/or cases'),
    ).toEqual([
      { kind: 'text', value: 'check /api/provider and either/or cases' },
    ])
  })

  it('ignores slashes inside URLs', () => {
    expect(
      splitSlashCommandSegments('see https://falcondeck.com/docs today'),
    ).toEqual([
      { kind: 'text', value: 'see https://falcondeck.com/docs today' },
    ])
  })

  it('returns a single text segment when nothing matches', () => {
    expect(splitSlashCommandSegments('no commands here')).toEqual([
      { kind: 'text', value: 'no commands here' },
    ])
  })

  it('returns no segments for empty text', () => {
    expect(splitSlashCommandSegments('')).toEqual([])
  })
})

describe('activeSlashQuery', () => {
  it('treats a lone slash as an empty query so the full list is shown', () => {
    expect(activeSlashQuery('/', 1)).toEqual({
      query: '',
      rangeStart: 0,
      rangeEnd: 1,
    })
  })

  it('canonicalizes a typed skill prefix', () => {
    expect(activeSlashQuery('/Lin', 4)?.query).toBe('lin')
  })

  it('replaces the whole slash token when the caret is in its middle', () => {
    expect(activeSlashQuery('/linting now', 4)).toEqual({
      query: 'lin',
      rangeStart: 0,
      rangeEnd: 8,
    })
    expect(activeSlashQuery('/api/provider', 4)).toBeNull()
  })
})

const copyEditingSkill: SkillSummary = {
  id: 'skill:copy-editing',
  label: 'Copy editing',
  alias: '/copy-editing',
  availability: 'both',
  providers: ['codex', 'claude', 'grok'],
  source_kind: 'project_file',
  description:
    'Edit, review, proofread, polish, tighten, or refresh existing marketing copy while preserving the core message.',
}

const freshEyesSkill: SkillSummary = {
  id: 'skill:fresh-eyes-review',
  label: 'Fresh eyes review',
  alias: '/fresh-eyes-review',
  availability: 'both',
  providers: ['codex', 'claude', 'grok'],
  source_kind: 'project_file',
  description:
    'Reread recent code, catch obvious bugs/smells, and make focused cleanup fixes before handoff.',
}

describe('filterSlashSkills', () => {
  it('omits skills the current provider cannot use and filters by query', () => {
    expect(filterSlashSkills([lintSkill, grokSkill], 'grok', '')).toEqual([
      grokSkill,
    ])
    expect(filterSlashSkills([lintSkill, grokSkill], 'codex', 'lin')).toEqual([
      lintSkill,
    ])
    expect(filterSlashSkills([lintSkill, grokSkill], 'codex', 'grok')).toEqual(
      [],
    )
  })

  it('ranks an alias prefix above a description that only contains the query mid-word', () => {
    expect(
      filterSlashSkills(
        [copyEditingSkill, freshEyesSkill],
        'codex',
        'fresh',
      ).map((skill) => skill.alias),
    ).toEqual(['/fresh-eyes-review'])
  })

  it('matches hyphenated alias segments and description words, not mid-word noise', () => {
    expect(
      filterSlashSkills([copyEditingSkill, freshEyesSkill], 'codex', 'edit').map(
        (skill) => skill.alias,
      ),
    ).toEqual(['/copy-editing'])
    expect(
      filterSlashSkills(
        [copyEditingSkill, freshEyesSkill],
        'codex',
        'proof',
      ).map((skill) => skill.alias),
    ).toEqual(['/copy-editing'])
    expect(
      filterSlashSkills([copyEditingSkill, freshEyesSkill], 'codex', 'eyes').map(
        (skill) => skill.alias,
      ),
    ).toEqual(['/fresh-eyes-review'])
  })
})

describe('scoreSlashFields', () => {
  it('scores an exact alias above a prefix and a word hit', () => {
    const exact = scoreSlashFields('lint', {
      alias: '/lint',
      label: 'Lint',
      description: 'Run lint fixes',
    })
    const prefix = scoreSlashFields('lin', {
      alias: '/lint',
      label: 'Lint',
      description: 'Run lint fixes',
    })
    const word = scoreSlashFields('eyes', {
      alias: '/fresh-eyes-review',
      label: 'Fresh eyes review',
    })
    expect(exact?.score).toBe(0)
    expect(prefix?.score).toBeGreaterThan(0)
    expect(word?.match).toEqual({ field: 'alias', start: 6, length: 4 })
    expect(prefix!.score).toBeLessThan(word!.score)
  })

  it('does not treat a mid-word description hit as a match', () => {
    expect(
      scoreSlashFields('fresh', {
        alias: '/copy-editing',
        label: 'Copy editing',
        description: 'refresh existing marketing copy',
      }),
    ).toBeNull()
  })

  it('still matches a later word after skipping a mid-word hit', () => {
    const scored = scoreSlashFields('fresh', {
      alias: '/copy-editing',
      label: 'Copy editing',
      description: 'refresh the fresh draft',
    })
    expect(scored?.match).toEqual({
      field: 'description',
      start: 12,
      length: 5,
    })
  })

  it('ignores one-letter description words so /c does not match "current"', () => {
    expect(
      scoreSlashFields('c', {
        alias: '/deslop',
        label: 'Deslop',
        description: 'Strip slop from the current diff.',
      }),
    ).toBeNull()
  })
})

describe('rankSlashSuggestions', () => {
  it('keeps native commands first on an empty query, then skills alphabetically', () => {
    const ranked = rankSlashSuggestions({
      skills: [freshEyesSkill, copyEditingSkill],
      provider: 'codex',
      query: '',
      native: { goal: true, compact: true },
    })
    expect(ranked.map((item) => item.id)).toEqual([
      'native:goal',
      'native:compact',
      'skill:copy-editing',
      'skill:fresh-eyes-review',
    ])
  })

  it('selects the alias prefix over a native command that only matches as a weaker field', () => {
    const ranked = rankSlashSuggestions({
      skills: [copyEditingSkill, freshEyesSkill],
      provider: 'codex',
      query: 'fresh',
      native: { goal: true, compact: true },
    })
    expect(ranked[0]).toMatchObject({
      kind: 'skill',
      skill: { alias: '/fresh-eyes-review' },
    })
    expect(ranked.map((item) => item.id)).toEqual(['skill:fresh-eyes-review'])
  })

  it('does not let a one-letter query pull in description words', () => {
    const ranked = rankSlashSuggestions({
      skills: [copyEditingSkill, freshEyesSkill, grokSkill],
      provider: 'codex',
      query: 'c',
      native: { compact: true },
    })
    expect(ranked.map((item) => item.id)).toEqual([
      'native:compact',
      'skill:copy-editing',
    ])
  })

  it('does not let a native command match from the middle of its name', () => {
    expect(
      rankSlashSuggestions({
        skills: [],
        provider: 'codex',
        query: 'act',
        native: { compact: true },
      }),
    ).toEqual([])
    expect(
      rankSlashSuggestions({
        skills: [],
        provider: 'codex',
        query: 'comp',
        native: { compact: true },
      })[0]?.id,
    ).toBe('native:compact')
  })

  it('maps alias highlight indices onto a leading slash', () => {
    const ranked = rankSlashSuggestions({
      skills: [freshEyesSkill],
      provider: 'codex',
      query: 'fresh',
    })
    expect(ranked[0]?.match).toEqual({
      field: 'alias',
      start: 1,
      length: 5,
    })
  })
})

describe('slashSkillSourceLabel', () => {
  it('uses short source names instead of raw enum strings', () => {
    expect(slashSkillSourceLabel('project_file')).toBe('Project')
    expect(slashSkillSourceLabel('home_file')).toBe('User')
    expect(slashSkillSourceLabel('provider_native')).toBe('Built-in')
  })
})

describe('composerSkillCatalog', () => {
  it('uses a live fetch only when workspace and provider match', () => {
    const workspace = { id: 'ws-1', skills: [lintSkill] }
    const live = {
      workspaceId: 'ws-1',
      provider: 'grok',
      skills: [grokSkill],
    }
    expect(composerSkillCatalog(live, workspace, 'grok')).toEqual([grokSkill])
    expect(composerSkillCatalog(live, workspace, 'codex')).toEqual([lintSkill])
    expect(
      composerSkillCatalog(
        { ...live, workspaceId: 'ws-2' },
        workspace,
        'grok',
      ),
    ).toEqual([lintSkill])
  })
})
