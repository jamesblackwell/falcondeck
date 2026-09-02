import { describe, expect, it } from 'vitest'

import type { Automation } from '@falcondeck/client-core'

import {
  automationDraftArguments,
  automationDraftError,
  automationDraftFromDefinition,
  emptyAutomationDraft,
} from './model'

const automation: Automation = {
  id: 'automation-1',
  revision: 4,
  name: 'Inbox review',
  description: 'Weekdays',
  trigger: {
    kind: 'interval',
    every_seconds: 3600,
    anchor_at: '2026-08-20T08:00:00Z',
  },
  task: {
    kind: 'conditional_prompt',
    instruction: 'Review the inbox.',
    no_action_marker: 'NO_ACTION',
  },
  target: {
    workspace_path: '/tmp/project',
    provider: 'codex',
    thread: { kind: 'managed', thread_id: 'thread-1' },
    model_id: 'gpt-5',
    permission_mode: 'default',
    sandbox_mode: 'workspace-write',
    selected_skills: ['gmail'],
  },
  state: 'enabled',
  concurrency_policy: 'queue_one',
  misfire_policy: 'run_once',
  elevated: false,
  required_connectors: ['gmail'],
  created_at: '2026-08-20T08:00:00Z',
  updated_at: '2026-08-20T08:00:00Z',
  next_run_at: '2026-08-20T09:00:00Z',
}

describe('automation drafts', () => {
  it('preserves thread and interval anchors while editing', () => {
    const draft = automationDraftFromDefinition(automation)
    const payload = automationDraftArguments({ ...draft, name: 'Renamed' })

    expect(payload).toMatchObject({
      name: 'Renamed',
      trigger: {
        kind: 'interval',
        every_seconds: 3600,
        anchor_at: '2026-08-20T08:00:00Z',
      },
      target: {
        thread: { kind: 'managed', thread_id: 'thread-1' },
        selected_skills: ['gmail'],
      },
      required_connectors: ['gmail'],
    })
  })

  it('builds the same validated create shape as desktop', () => {
    const draft = {
      ...emptyAutomationDraft(null, '/tmp/project'),
      name: 'Deploy watch',
      instruction: 'Check deployments.',
      requiredConnectors: 'github, slack',
    }

    expect(automationDraftError(draft)).toBeNull()
    expect(automationDraftArguments(draft)).toMatchObject({
      name: 'Deploy watch',
      trigger: { kind: 'cron', expression: '0 8 * * 1-5' },
      task: { kind: 'prompt', instruction: 'Check deployments.' },
      target: {
        workspace_path: '/tmp/project',
        provider: 'codex',
        thread: { kind: 'managed' },
      },
      required_connectors: ['github', 'slack'],
    })
  })

  it('rejects invalid mobile input before sending it', () => {
    expect(automationDraftError(emptyAutomationDraft(null))).toBe('A name is required.')
    expect(automationDraftError({
      ...emptyAutomationDraft(null, 'relative/path'),
      name: 'Task',
      instruction: 'Do it',
    })).toBe('Workspace path must be absolute.')
    expect(automationDraftError({
      ...emptyAutomationDraft(null, '/tmp/project'),
      name: 'Task',
      instruction: 'Do it',
      scheduleKind: 'interval',
      everySeconds: '30',
    })).toBe('Intervals must be at least 60 seconds.')

    const nonNumeric = {
      ...emptyAutomationDraft(null, '/tmp/project'),
      name: 'Task',
      instruction: 'Do it',
      scheduleKind: 'interval' as const,
      everySeconds: 'not-a-number',
    }
    expect(automationDraftError(nonNumeric)).toBe('Intervals must be at least 60 seconds.')
    expect(() => automationDraftArguments(nonNumeric)).toThrow(/finite number/)
  })
})
