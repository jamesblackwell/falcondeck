import { describe, expect, it } from 'vitest'

import { splitSlashCommandSegments } from './skills'

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
