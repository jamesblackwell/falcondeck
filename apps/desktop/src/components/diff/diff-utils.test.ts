import { describe, expect, it } from 'vitest'

import { homeRelativePath, isMarkdownFilePath, statusLabel, statusToneClass } from './diff-utils'

describe('homeRelativePath', () => {
  it('abbreviates a home directory on macOS and Linux', () => {
    expect(homeRelativePath('/Users/James/www/sites/falcondeck')).toBe('~/www/sites/falcondeck')
    expect(homeRelativePath('/home/forge/projects/app')).toBe('~/projects/app')
    expect(homeRelativePath('/Users/James')).toBe('~')
  })

  it('leaves paths outside a home directory alone', () => {
    expect(homeRelativePath('/opt/builds/app')).toBe('/opt/builds/app')
    // A sibling of /Users that merely starts the same way is not a home dir.
    expect(homeRelativePath('/UsersData/app')).toBe('/UsersData/app')
  })
})

describe('isMarkdownFilePath', () => {
  it('recognizes markdown extensions', () => {
    expect(isMarkdownFilePath('docs/qa/notes.md')).toBe(true)
    expect(isMarkdownFilePath('README.MD')).toBe(true)
    expect(isMarkdownFilePath('page.mdx')).toBe(true)
    expect(isMarkdownFilePath('guide.markdown')).toBe(true)
    expect(isMarkdownFilePath('src/App.tsx')).toBe(false)
    expect(isMarkdownFilePath('notes.md.bak')).toBe(false)
  })
})

describe('statusLabel', () => {
  it('uses git letters, with U for untracked', () => {
    expect(statusLabel('modified')).toBe('M')
    expect(statusLabel('untracked')).toBe('U')
    expect(statusLabel('renamed')).toBe('R')
  })

  it('tones added and deleted apart from a rename', () => {
    expect(statusToneClass('added')).toBe('text-success')
    expect(statusToneClass('deleted')).toBe('text-danger')
    expect(statusToneClass('renamed')).toBe('text-warning')
    expect(statusToneClass('modified')).toBe('text-info')
  })
})
