import { describe, expect, it } from 'vitest'

import {
  defaultCollaborationModeId,
  isPlanModeEnabled,
  supportsPlanMode,
  togglePlanMode,
  type ThreadSummary,
  type WorkspaceSummary,
} from '@falcondeck/client-core'

import {
  defaultModelId,
  defaultReasoningEffort,
  reasoningOptions,
  resolveReasoningEffort,
  resolveThreadModelId,
} from './utils'

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: 'workspace-1',
    path: '/Users/james/falcondeck',
    status: 'ready',
    agents: [],
    default_provider: 'codex',
    models: [],
    collaboration_modes: [],
    account: { status: 'ready', label: 'ready' },
    current_thread_id: null,
    connected_at: '2026-03-17T08:00:00Z',
    updated_at: '2026-03-17T08:00:00Z',
    last_error: null,
    supports_plan_mode: true,
    supports_native_plan_mode: true,
    ...overrides,
  }
}

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'thread-1',
    workspace_id: 'workspace-1',
    title: 'Thread',
    provider: 'codex',
    native_session_id: null,
    status: 'idle',
    updated_at: '2026-03-17T08:00:00Z',
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
    },
    attention: {
      level: 'none',
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    is_archived: false,
    ...overrides,
  }
}

describe('desktop selection utils', () => {
  it('prefers the declared default model', () => {
    const selected = defaultModelId(
      workspace({
        models: [
          {
            id: 'gpt-5.3-codex',
            label: 'GPT-5.3-Codex',
            is_default: false,
            default_reasoning_effort: 'medium',
            supported_reasoning_efforts: [],
          },
          {
            id: 'gpt-5.4',
            label: 'GPT-5.4',
            is_default: true,
            default_reasoning_effort: 'medium',
            supported_reasoning_efforts: [],
          },
        ],
      }),
    )

    expect(selected).toBe('gpt-5.4')
  })

  it('keeps the full supported reasoning order from codex metadata', () => {
    const selectedWorkspace = workspace({
      models: [
        {
          id: 'gpt-5.4',
          label: 'GPT-5.4',
          is_default: true,
          default_reasoning_effort: 'medium',
          supported_reasoning_efforts: [
            { reasoning_effort: 'low', description: 'Low' },
            { reasoning_effort: 'medium', description: 'Medium' },
            { reasoning_effort: 'high', description: 'High' },
            { reasoning_effort: 'xhigh', description: 'Extra high' },
          ],
        },
      ],
    })

    expect(reasoningOptions(null, selectedWorkspace, 'gpt-5.4')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  it('uses the selected provider models for a new thread instead of the workspace default provider', () => {
    const selectedWorkspace = workspace({
      default_provider: 'claude',
      agents: [
        {
          provider: 'codex',
          account: { status: 'ready', label: 'ready' },
          models: [
            {
              id: 'gpt-5.4',
              label: 'GPT-5.4',
              is_default: true,
              default_reasoning_effort: 'medium',
              supported_reasoning_efforts: [
                { reasoning_effort: 'low', description: 'Low' },
                { reasoning_effort: 'medium', description: 'Medium' },
                { reasoning_effort: 'high', description: 'High' },
              ],
            },
          ],
          collaboration_modes: [],
        },
        {
          provider: 'claude',
          account: { status: 'ready', label: 'ready' },
          models: [
            {
              id: 'sonnet',
              label: 'Sonnet',
              is_default: true,
              default_reasoning_effort: 'medium',
              supported_reasoning_efforts: [
                { reasoning_effort: 'medium', description: 'Medium' },
              ],
            },
          ],
          collaboration_modes: [],
        },
      ],
      models: [],
    })

    expect(reasoningOptions(null, selectedWorkspace, 'gpt-5.4', 'codex')).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(defaultReasoningEffort(null, selectedWorkspace, 'gpt-5.4', 'codex')).toBe('medium')
    expect(resolveThreadModelId(null, selectedWorkspace, null, 'codex')).toBe('gpt-5.4')
  })

  it('uses the model default reasoning effort for initial selection', () => {
    const selectedWorkspace = workspace({
      models: [
        {
          id: 'gpt-5.4',
          label: 'GPT-5.4',
          is_default: true,
          default_reasoning_effort: 'medium',
          supported_reasoning_efforts: [
            { reasoning_effort: 'low', description: 'Low' },
            { reasoning_effort: 'medium', description: 'Medium' },
            { reasoning_effort: 'high', description: 'High' },
            { reasoning_effort: 'xhigh', description: 'Extra high' },
          ],
        },
      ],
    })

    expect(defaultReasoningEffort(null, selectedWorkspace, 'gpt-5.4')).toBe('medium')
  })

  it('falls back to the first supported effort when no explicit default exists', () => {
    const selectedWorkspace = workspace({
      models: [
        {
          id: 'gpt-legacy',
          label: 'GPT Legacy',
          is_default: true,
          default_reasoning_effort: null,
          supported_reasoning_efforts: [
            { reasoning_effort: 'low', description: 'Low' },
            { reasoning_effort: 'medium', description: 'Medium' },
          ],
        },
      ],
    })

    expect(defaultReasoningEffort(null, selectedWorkspace, 'gpt-legacy')).toBe('low')
  })

  it('resolves the thread model before choosing the default effort', () => {
    const selectedWorkspace = workspace({
      models: [
        {
          id: 'gpt-5.4',
          label: 'GPT-5.4',
          is_default: true,
          default_reasoning_effort: 'medium',
          supported_reasoning_efforts: [{ reasoning_effort: 'medium', description: 'Medium' }],
        },
        {
          id: 'gpt-5.3-codex-spark',
          label: 'GPT-5.3-Codex-Spark',
          is_default: false,
          default_reasoning_effort: 'high',
          supported_reasoning_efforts: [
            { reasoning_effort: 'low', description: 'Low' },
            { reasoning_effort: 'high', description: 'High' },
          ],
        },
      ],
    })
    const selectedThread = thread({
      agent: {
        model_id: 'gpt-5.3-codex-spark',
        reasoning_effort: null,
        collaboration_mode_id: null,
        approval_policy: null,
        service_tier: null,
      },
    })

    expect(resolveThreadModelId(selectedThread, selectedWorkspace)).toBe('gpt-5.3-codex-spark')
    expect(defaultReasoningEffort(selectedThread, selectedWorkspace)).toBe('high')
  })

  it('falls back to the provider default when a preferred model is stale', () => {
    const selectedWorkspace = workspace({
      models: [
        {
          id: 'gpt-5.4',
          label: 'GPT-5.4',
          is_default: true,
          default_reasoning_effort: 'medium',
          supported_reasoning_efforts: [{ reasoning_effort: 'medium', description: 'Medium' }],
        },
      ],
    })

    expect(resolveThreadModelId(null, selectedWorkspace, 'gpt-5.1-codex-max')).toBe('gpt-5.4')
  })

  it('prefers a valid remembered effort over thread and model defaults', () => {
    const selectedWorkspace = workspace({
      models: [
        {
          id: 'gpt-5.4',
          label: 'GPT-5.4',
          is_default: true,
          default_reasoning_effort: 'medium',
          supported_reasoning_efforts: [
            { reasoning_effort: 'low', description: 'Low' },
            { reasoning_effort: 'medium', description: 'Medium' },
            { reasoning_effort: 'high', description: 'High' },
          ],
        },
      ],
    })
    const selectedThread = thread({
      agent: {
        model_id: 'gpt-5.4',
        reasoning_effort: 'medium',
        collaboration_mode_id: null,
        approval_policy: null,
        service_tier: null,
      },
    })

    expect(
      resolveReasoningEffort(selectedThread, selectedWorkspace, 'gpt-5.4', 'high'),
    ).toBe('high')
  })

  it('does not auto-enable plan mode for a new thread', () => {
    const selectedWorkspace = workspace({
      collaboration_modes: [
        {
          id: 'plan',
          label: 'Plan',
          mode: 'plan',
          model_id: null,
          reasoning_effort: 'medium',
          is_native: true,
        },
      ],
    })

    expect(defaultCollaborationModeId(null)).toBeNull()
    expect(supportsPlanMode(selectedWorkspace)).toBe(true)
    expect(isPlanModeEnabled(null, selectedWorkspace)).toBe(false)
  })

  it('enables and disables plan mode using the canonical plan id', () => {
    const selectedWorkspace = workspace({
      collaboration_modes: [
        {
          id: 'plan',
          label: 'Plan',
          mode: 'plan',
          model_id: null,
          reasoning_effort: 'medium',
          is_native: true,
        },
      ],
    })

    expect(togglePlanMode(true, selectedWorkspace, null)).toBe('plan')
    expect(isPlanModeEnabled('plan', selectedWorkspace)).toBe(true)
    expect(togglePlanMode(false, selectedWorkspace, 'plan')).toBeNull()
  })
})
