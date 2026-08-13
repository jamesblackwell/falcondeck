import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ExtensionSnapshot } from '@falcondeck/client-core'

import { ExtensionsPanel } from './ExtensionsPanel'

describe('ExtensionsPanel compatibility fallback', () => {
  it('keeps newer contribution kinds visible to an older client', () => {
    const extensions: ExtensionSnapshot = {
      catalog: [{
        id: 'example.future',
        name: 'Future extension',
        version: '1.0.0',
        source: 'local',
        bundled: false,
        enabled: true,
        status: 'active',
        contributes: {
          threadMenuActions: [],
          threadDecorations: [],
          sidebarFilters: [],
          unsupported: [{ kind: 'panels', entries: [{ id: 'future' }] }],
        },
        permissions: [],
      }],
      views: [],
    }

    render(<ExtensionsPanel extensions={extensions} onSetEnabled={vi.fn()} />)

    expect(screen.getByRole('status').textContent).toContain('panels')
  })
})
