import { describe, expect, it } from 'vitest'

import {
  DEFAULT_THREAD_STAGES,
  deriveThreadTags,
  optimisticallySetThreadStage,
} from './extension-views'
import type { ExtensionSnapshot } from './types'

const snapshot: ExtensionSnapshot = {
  catalog: [{
    id: 'falcondeck.thread-tags',
    name: 'Thread Stages',
    version: '0.3.0',
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
      value: { tags: DEFAULT_THREAD_STAGES },
      updated_at: '2026-08-12T00:00:00Z',
    },
    {
      extension_id: 'falcondeck.thread-tags',
      view_id: 'thread-tags',
      scope: { kind: 'thread', id: 'thread-1' },
      value: { tagIds: ['in_progress'] },
      updated_at: '2026-08-12T00:00:01Z',
    },
  ],
}

describe('deriveThreadTags', () => {
  it('joins the published stage catalog and thread assignment', () => {
    const projection = deriveThreadTags(snapshot)
    expect(projection.tags).toHaveLength(5)
    expect(projection.byThreadId).toEqual({
      'thread-1': [DEFAULT_THREAD_STAGES[1]],
    })
  })

  it('falls back to the default stages before the host publishes a catalog', () => {
    expect(deriveThreadTags({
      ...snapshot,
      views: [{
        extension_id: 'falcondeck.thread-tags',
        view_id: 'thread-tags',
        scope: { kind: 'thread', id: 'thread-1' },
        value: { tagIds: ['done'] },
        updated_at: '2026-08-12T00:00:01Z',
      }],
    }).byThreadId['thread-1']?.[0]?.id).toBe('done')
  })

  it('ignores retained Finder-style colour catalogs', () => {
    const projection = deriveThreadTags({
      ...snapshot,
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
    })
    expect(projection.tags.map(tag => tag.id)).toEqual(DEFAULT_THREAD_STAGES.map(tag => tag.id))
    expect(projection.byThreadId['thread-1']).toEqual([])
  })

  it('keeps custom stages from a published catalog', () => {
    const blocked = { id: 'blocked', label: 'Blocked', color: 'red', icon: 'custom' }
    const projection = deriveThreadTags({
      ...snapshot,
      views: [{
        extension_id: 'falcondeck.thread-tags',
        view_id: 'tag-index',
        value: { tags: [...DEFAULT_THREAD_STAGES, blocked] },
        updated_at: '2026-08-12T00:00:00Z',
      }],
    })
    expect(projection.tags).toHaveLength(6)
    expect(projection.tags.at(-1)).toEqual(blocked)
  })

  it('hides retained projections while the extension is disabled', () => {
    expect(deriveThreadTags({
      ...snapshot,
      catalog: [{ ...snapshot.catalog[0]!, enabled: false, status: 'disabled' }],
    })).toEqual({ tags: [], byThreadId: {} })
  })
})

describe('optimisticallySetThreadStage', () => {
  it('replaces one thread projection without mutating the snapshot', () => {
    const extensions = snapshot
    const updated = optimisticallySetThreadStage(extensions, 'thread-1', 'done')

    expect(deriveThreadTags(updated).byThreadId['thread-1']?.[0]?.id).toBe('done')
    expect(deriveThreadTags(extensions).byThreadId['thread-1']?.[0]?.id).toBe('in_progress')
  })
})
