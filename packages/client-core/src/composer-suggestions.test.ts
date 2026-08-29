import { describe, expect, it } from 'vitest'

import {
  deriveComposerSuggestions,
  MAX_COMPOSER_SUGGESTION_PROMPT_CHARS,
} from './composer-suggestions'
import type { ExtensionSnapshot, ExtensionSummary, ThreadStatus } from './types'

const EXTENSION_ID = 'falcondeck.follow-up-suggestions'

function summary(overrides: Partial<ExtensionSummary> = {}): ExtensionSummary {
  return {
    id: EXTENSION_ID,
    name: 'Follow-up suggestions',
    version: '0.1.0',
    source: 'bundled',
    bundled: true,
    enabled: true,
    status: 'active',
    contributes: {
      threadMenuActions: [],
      threadDecorations: [],
      sidebarFilters: [],
      panels: [],
      composerSuggestions: [{ id: 'follow-ups', view: 'follow-ups' }],
    },
    permissions: ['agent-tools:register'],
    granted_permissions: ['agent-tools:register'],
    ...overrides,
  }
}

function snapshot(value: unknown, overrides: Partial<ExtensionSummary> = {}): ExtensionSnapshot {
  return {
    catalog: [summary(overrides)],
    views: [
      {
        extension_id: EXTENSION_ID,
        view_id: 'follow-ups',
        scope: { kind: 'thread', id: 'thread-1' },
        value,
        updated_at: '2026-08-20T10:00:00.000Z',
      },
    ],
  }
}

const TWO_ACTIONS = {
  actions: [
    { id: 'run-tests', label: 'Run the test suite', prompt: 'Run the tests.' },
    { id: 'ship', label: 'Ship it', description: 'Open a PR', prompt: 'Open a pull request.' },
  ],
}

function derive(
  extensions: ExtensionSnapshot,
  status: ThreadStatus = 'idle',
  threadId: string | null = 'thread-1',
) {
  return deriveComposerSuggestions(extensions, threadId, status)
}

describe('deriveComposerSuggestions', () => {
  it('offers the published actions once the turn is idle', () => {
    const offer = derive(snapshot(TWO_ACTIONS))
    expect(offer?.extensionId).toBe(EXTENSION_ID)
    expect(offer?.primary.label).toBe('Run the test suite')
    expect(offer?.actions.map(action => action.id)).toEqual(['run-tests', 'ship'])
  })

  it('withholds offers unless the associated turn has settled cleanly', () => {
    // running/waiting: the composer still belongs to that turn.
    // error: the offers were derived from work that did not finish.
    for (const status of ['running', 'waiting_for_input', 'error'] as ThreadStatus[]) {
      expect(derive(snapshot(TWO_ACTIONS), status)).toBeNull()
    }
  })

  it('promotes the preferred action into the primary segment', () => {
    const offer = derive(snapshot({ ...TWO_ACTIONS, preferredActionId: 'ship' }))
    expect(offer?.primary.id).toBe('ship')
    expect(offer?.actions.map(action => action.id)).toEqual(['ship', 'run-tests'])
  })

  it('ignores a preferred id that is not on offer', () => {
    const offer = derive(snapshot({ ...TWO_ACTIONS, preferredActionId: 'missing' }))
    expect(offer?.primary.id).toBe('run-tests')
  })

  it('returns nothing for a cleared set, a disabled extension, or another thread', () => {
    expect(derive(snapshot({ actions: [] }))).toBeNull()
    expect(derive(snapshot(TWO_ACTIONS, { enabled: false }))).toBeNull()
    expect(derive(snapshot(TWO_ACTIONS), 'idle', 'thread-2')).toBeNull()
    expect(derive(snapshot(TWO_ACTIONS), 'idle', null)).toBeNull()
  })

  it('ignores views the extension never declared as composer suggestions', () => {
    const undeclared = snapshot(TWO_ACTIONS, {
      contributes: {
        threadMenuActions: [],
        threadDecorations: [],
        sidebarFilters: [],
        panels: [],
        composerSuggestions: [],
      },
    })
    expect(derive(undeclared)).toBeNull()
  })

  it('drops malformed actions and caps the set at five', () => {
    const offer = derive(
      snapshot({
        actions: [
          null,
          { id: 'ok', label: 'Ship it', prompt: 'Ship.' },
          { id: 'no-prompt', label: 'Broken' },
          { label: 'No id', prompt: 'x' },
          ...Array.from({ length: 6 }, (_, index) => ({
            id: `extra-${index}`,
            label: `Extra ${index}`,
            prompt: 'x',
          })),
        ],
      }),
    )
    expect(offer?.actions).toHaveLength(5)
    expect(offer?.actions.every(action => action.prompt.length > 0)).toBe(true)
  })

  it('truncates a label that exceeds the published bound rather than dropping it', () => {
    const offer = derive(
      snapshot({
        actions: [
          {
            id: 'long',
            label: 'A label that is much longer than the published bound',
            prompt: 'Do it.',
          },
        ],
      }),
    )
    expect(offer?.primary.label).toHaveLength(30)
    expect(offer?.primary.label.endsWith('…')).toBe(true)
  })

  it('truncates prompts by Unicode characters without splitting an emoji', () => {
    const prefix = 'a'.repeat(MAX_COMPOSER_SUGGESTION_PROMPT_CHARS - 1)
    const offer = derive(
      snapshot({
        actions: [
          {
            id: 'unicode',
            label: 'Keep emoji intact',
            prompt: `${prefix}😀ignored`,
          },
        ],
      }),
    )

    expect(offer?.primary.prompt).toBe(`${prefix}😀`)
    expect(Array.from(offer?.primary.prompt ?? '')).toHaveLength(
      MAX_COMPOSER_SUGGESTION_PROMPT_CHARS,
    )
  })

  it('collapses a multi-line description onto one line', () => {
    const offer = derive(
      snapshot({
        actions: [
          { id: 'a', label: 'Ship it', description: 'first\n\nsecond', prompt: 'Ship.' },
        ],
      }),
    )
    expect(offer?.primary.description).toBe('first second')
  })

  it('changes its key whenever the offered set changes', () => {
    const first = derive(snapshot(TWO_ACTIONS))
    const second = derive(
      snapshot({ actions: [{ id: 'other', label: 'Other', prompt: 'x' }] }),
    )
    expect(first?.key).not.toBe(second?.key)
  })

  it('picks one extension deterministically when two publish offers', () => {
    const base = snapshot(TWO_ACTIONS)
    const both: ExtensionSnapshot = {
      catalog: [
        ...base.catalog,
        summary({ id: 'aaa.other', name: 'Other' }),
      ],
      views: [
        ...base.views,
        {
          extension_id: 'aaa.other',
          view_id: 'follow-ups',
          scope: { kind: 'thread', id: 'thread-1' },
          value: { actions: [{ id: 'z', label: 'From other', prompt: 'x' }] },
          updated_at: '2026-08-20T11:00:00.000Z',
        },
      ],
    }
    expect(derive(both)?.extensionId).toBe('aaa.other')
    expect(derive(both)?.extensionId).toBe('aaa.other')
  })
})
