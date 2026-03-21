import { describe, expect, it } from 'vitest'

import type { WorkspaceSummary } from '@falcondeck/client-core'

import { normalizeSendError, workspaceSendBlockReason } from './app-utils'

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: 'workspace-1',
    path: '/Users/james/falcondeck',
    status: 'ready',
    agents: [],
    default_provider: 'codex',
    models: [],
    collaboration_modes: [],
    account: { status: 'ready', label: 'Ready' },
    current_thread_id: null,
    connected_at: '2026-03-20T12:00:00Z',
    updated_at: '2026-03-20T12:00:00Z',
    last_error: null,
    supports_plan_mode: true,
    supports_native_plan_mode: true,
    ...overrides,
  }
}

describe('workspaceSendBlockReason', () => {
  it('surfaces reconnecting project guidance', () => {
    expect(
      workspaceSendBlockReason(
        workspace({
          status: 'connecting',
          path: '/Users/james/falcondeck/alpha',
        }),
        'codex',
      ),
    ).toContain('alpha is still reconnecting')
  })

  it('blocks when the selected provider needs auth', () => {
    expect(
      workspaceSendBlockReason(
        workspace({
          agents: [
            {
              provider: 'claude',
              account: { status: 'needs_auth', label: 'Sign in' },
              models: [],
              collaboration_modes: [],
            },
          ],
        }),
        'claude',
      ),
    ).toBe('Claude needs authentication in this project before you can send messages.')
  })
})

describe('normalizeSendError', () => {
  it('rewrites Claude connectivity failures into actionable copy', () => {
    expect(normalizeSendError('workspace is not currently connected to Claude', 'claude')).toContain(
      'not connected to Claude yet',
    )
  })

  it('preserves unrelated errors', () => {
    expect(normalizeSendError('Something else went wrong', 'codex')).toBe('Something else went wrong')
  })
})
