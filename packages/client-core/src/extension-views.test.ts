import { describe, expect, it } from 'vitest'

import { deriveThreadTags, optimisticallySetThreadColor } from './extension-views'
import type { ExtensionSnapshot } from './types'

const snapshot: ExtensionSnapshot = {
  catalog: [{
    id: 'falcondeck.thread-tags',
    name: 'Thread Colours',
    version: '0.2.0',
    source: 'bundled',
    bundled: true,
    enabled: true,
    status: 'active',
    contributes: { threadMenuActions: [], threadDecorations: [], sidebarFilters: [] },
    permissions: [],
  }],
  views: [
    {
      extension_id: 'falcondeck.thread-tags',
      view_id: 'tag-index',
      value: {
        tags: ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'].map(color => ({
          id: color,
          label: color[0]!.toUpperCase() + color.slice(1),
          color,
        })),
      },
      updated_at: '2026-08-12T00:00:00Z',
    },
    {
      extension_id: 'falcondeck.thread-tags',
      view_id: 'thread-tags',
      scope: { kind: 'thread', id: 'thread-1' },
      value: { tagIds: ['red'] },
      updated_at: '2026-08-12T00:00:01Z',
    },
  ],
}

describe('deriveThreadTags', () => {
  it('joins the fixed colour palette and thread assignment', () => {
    const projection = deriveThreadTags(snapshot)
    expect(projection.tags).toHaveLength(8)
    expect(projection.byThreadId).toEqual({
      'thread-1': [{ id: 'red', label: 'Red', color: 'red' }],
    })
  })

  it('hides retained projections while the extension is disabled', () => {
    expect(deriveThreadTags({
      ...snapshot,
      catalog: [{ ...snapshot.catalog[0]!, enabled: false, status: 'disabled' }],
    })).toEqual({ tags: [], byThreadId: {} })
  })
})

describe('optimisticallySetThreadColor', () => {
  it('replaces one thread projection without mutating the snapshot', () => {
    const extensions = snapshot
    const updated = optimisticallySetThreadColor(extensions, 'thread-1', 'green')

    expect(deriveThreadTags(updated).byThreadId['thread-1']?.[0]?.id).toBe('green')
    expect(deriveThreadTags(extensions).byThreadId['thread-1']?.[0]?.id).toBe('red')
  })
})
