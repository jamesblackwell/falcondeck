import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetAllStores } from 'react-native-mmkv'

import type { AgentControlSettings, Automation, ControlGetResponse } from '@falcondeck/client-core'

import { loadAutomationCache, persistAutomationCache } from '@/storage/automation-cache'

import { useAutomationStore } from './automation-store'
import { useRelayStore } from './relay-store'

const settings: AgentControlSettings = {
  enabled: true,
  providers: {},
  default_timezone: 'Europe/London',
  allow_elevated_automations: false,
  inject_agent_context: true,
  confirmation_policy: { destructive_operations: true, sensitive_operations: true },
}

const automation: Automation = {
  id: 'automation-1',
  revision: 4,
  name: 'Inbox review',
  trigger: { kind: 'cron', expression: '0 8 * * 1-5', timezone: 'Europe/London' },
  task: { kind: 'prompt', instruction: 'Review the inbox.' },
  target: {
    workspace_path: '/tmp/project',
    provider: 'codex',
    thread: { kind: 'managed' },
  },
  state: 'enabled',
  concurrency_policy: 'skip',
  misfire_policy: 'skip',
  elevated: false,
  required_connectors: [],
  created_at: '2026-08-20T08:00:00Z',
  updated_at: '2026-08-20T08:00:00Z',
  next_run_at: '2026-08-24T08:00:00Z',
}

function controlGet(resource: string, data: unknown): ControlGetResponse {
  return { resource, data, next_cursor: null }
}

beforeEach(() => {
  __resetAllStores()
  useAutomationStore.getState().reset()
})

describe('automation store', () => {
  it('hydrates a session-scoped cache before the relay responds', () => {
    persistAutomationCache({
      sessionId: 'session-1',
      automations: [automation],
      settings,
      runsByAutomation: {},
      savedAt: '2026-08-23T10:00:00Z',
    })

    useAutomationStore.getState().hydrate('session-1')
    expect(useAutomationStore.getState()).toMatchObject({
      hydrated: true,
      sessionId: 'session-1',
      automations: [automation],
      lastSyncedAt: '2026-08-23T10:00:00Z',
    })

    useAutomationStore.getState().hydrate('session-2')
    expect(useAutomationStore.getState().automations).toEqual([])
  })

  it('refreshes list and settings in parallel and persists them', async () => {
    const rpc = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      params.resource === 'automations'
        ? controlGet('automations', [automation, { bad: true }])
        : controlGet('agent_control.settings', settings),
    )
    useRelayStore.setState({ _callRpc: rpc as never })
    useAutomationStore.getState().hydrate('session-1')

    await useAutomationStore.getState().refresh()

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(useAutomationStore.getState().automations).toEqual([automation])
    expect(useAutomationStore.getState().settings).toEqual(settings)
    expect(loadAutomationCache('session-1')?.automations).toEqual([automation])
  })

  it('keeps daemon list-projection rows, which omit task, thread and timestamps', async () => {
    // Regression: the daemon's automation list projects out task,
    // target.thread and the timestamps; the strict normalizer used to drop
    // every row, so the app showed "No automations" against a live daemon.
    const listRow: Automation = {
      id: 'automation-1',
      revision: 4,
      name: 'Inbox review',
      state: 'enabled',
      trigger: { kind: 'cron', expression: '0 8 * * 1-5', timezone: 'Europe/London' },
      target: { workspace_path: '/tmp/project', provider: 'codex' },
      elevated: false,
      required_connectors: [],
      concurrency_policy: 'skip',
      misfire_policy: 'skip',
      next_run_at: '2026-08-24T08:00:00Z',
      last_run_at: '2026-08-23T08:00:00Z',
      latest_outcome: { status: 'succeeded', finished_at: '2026-08-23T08:00:31Z', preview: 'Done.' },
      resolved_schedule: 'cron "0 8 * * 1-5" (Europe/London)',
    }
    const rpc = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      params.resource === 'automations'
        ? controlGet('automations', [listRow])
        : controlGet('agent_control.settings', settings),
    )
    useRelayStore.setState({ _callRpc: rpc as never })
    useAutomationStore.getState().hydrate('session-1')

    await useAutomationStore.getState().refresh()

    expect(useAutomationStore.getState().automations).toEqual([listRow])
  })

  it('surfaces structured revision conflicts from mutations', async () => {
    const rpc = vi.fn().mockResolvedValue({
      ok: false,
      operation: 'automation.pause',
      error: {
        code: 'revision_conflict',
        message: 'Changed elsewhere.',
        retryable: true,
        field_errors: [],
        current_revision: 5,
        suggested_action: 'Refresh and retry with revision 5.',
      },
    })
    useRelayStore.setState({ _callRpc: rpc as never })

    await expect(useAutomationStore.getState().execute({
      operation: 'automation.pause',
      arguments: { automation_id: 'automation-1' },
      expected_revision: 4,
    })).rejects.toMatchObject({
      name: 'AutomationControlError',
      detail: { code: 'revision_conflict', current_revision: 5 },
    })
  })

  it('keeps a confirmed mutation successful when its follow-up refresh fails', async () => {
    const paused = { ...automation, state: 'paused' as const, revision: 5 }
    const rpc = vi.fn(async (method: string) => {
      if (method === 'control.execute') {
        return { ok: true, operation: 'automation.pause', data: paused }
      }
      throw new Error('Desktop disconnected after the mutation')
    })
    useRelayStore.setState({ _callRpc: rpc as never })
    useAutomationStore.setState({
      sessionId: 'session-1',
      hydrated: true,
      automations: [automation],
    })

    await expect(useAutomationStore.getState().execute({
      operation: 'automation.pause',
      arguments: { automation_id: automation.id },
      expected_revision: automation.revision,
    })).resolves.toEqual(paused)
    expect(useAutomationStore.getState().automations[0]).toEqual(paused)
  })
})
