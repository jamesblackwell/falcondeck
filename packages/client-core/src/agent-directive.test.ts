import { describe, expect, it } from 'vitest'

import {
  agentMarkdownCopyText,
  assistantMessageCopyText,
  parseAgentDirectiveLine,
  splitAgentMessageSegments,
  stripAgentDirectiveLines,
} from './agent-directive'

describe('agent directives', () => {
  it('parses known and future directives without discarding opaque provider detail', () => {
    expect(parseAgentDirectiveLine(
      '::future-action{cwd="/workspace/falcondeck" state=ready provider-fragment}',
    )).toEqual({
      name: 'future-action',
      attrs: [['cwd', '/workspace/falcondeck'], ['state', 'ready']],
      unparsed: 'provider-fragment',
    })
  })

  it('segments directives in provider order and preserves malformed terminal text', () => {
    expect(splitAgentMessageSegments([
      'Finished.',
      '::git-push{branch=main}',
      'Still readable.',
      '::git-push{missing brace',
    ].join('\n'))).toEqual([
      { kind: 'markdown', text: 'Finished.' },
      { kind: 'directive', name: 'git-push', attrs: [['branch', 'main']], unparsed: null },
      { kind: 'markdown', text: 'Still readable.\n::git-push{missing brace' },
    ])
  })

  it('copies semantic action evidence instead of raw machine syntax', () => {
    const text = [
      'Release completed.',
      '::git-commit{cwd="/workspace/falcondeck" commit=abc123}',
      '::future-action{state=ready provider-fragment}',
    ].join('\n')

    expect(agentMarkdownCopyText(text)).toBe([
      'Release completed.',
      'Agent action: git commit · cwd: /workspace/falcondeck · commit: abc123',
      'Agent action: future action · state: ready · detail: provider-fragment',
    ].join('\n'))
    expect(agentMarkdownCopyText(text)).not.toContain('::')
    expect(assistantMessageCopyText(text)).toBe(agentMarkdownCopyText(text))
  })

  it('suppresses only unfinished streaming syntax and restores it when terminal', () => {
    const text = 'Saved.\n::git-commit{cwd="/workspace/falcondeck"'
    expect(assistantMessageCopyText(text, true)).toBe('Saved.')
    expect(assistantMessageCopyText(text, false)).toBe(text)
    expect(splitAgentMessageSegments(text, true)).toEqual([{ kind: 'markdown', text: 'Saved.' }])
  })

  it('strips only complete directive lines from Markdown parsing', () => {
    expect(stripAgentDirectiveLines('Before\n::git-push{branch=main}\n::not-finished{state')).toBe(
      'Before\n::not-finished{state',
    )
  })
})
