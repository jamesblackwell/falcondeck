import { describe, expect, it } from 'vitest'

import {
  activeSlashQuery,
  composerSkillCatalog,
  filterSlashSkills,
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
})

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
