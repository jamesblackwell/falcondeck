import { describe, expect, it } from 'vitest'
import {
  defaultReasoningEffort, reasoningOptions, resolveModelOption,
  resolveReasoningEffort, resolveThreadModelId, threadComposerSelectionKey,
} from './model-selection'
import { normalizeDaemonSnapshot } from './normalization'
import { parseDaemonEvents } from './remote-events'
import { applySnapshotEvent } from './snapshot'
import type { ModelSummary } from './types'

const models: ModelSummary[] = ['sonnet', 'opus', 'haiku'].map((id) => ({
  id, label: `${id[0].toUpperCase()}${id.slice(1)} ${id === 'haiku' ? '4.5' : '5.5'}`,
  is_default: id === 'sonnet', default_reasoning_effort: id === 'opus' ? 'high' : 'medium',
  supported_reasoning_efforts: ['low', 'medium', 'high'].map((reasoning_effort) => ({
    reasoning_effort, description: reasoning_effort,
  })),
}))

function snapshot() {
  return normalizeDaemonSnapshot({
    daemon: { version: 'test', started_at: '2026-10-16T00:00:00Z' },
    workspaces: [{ id: 'w', path: '/repo', default_provider: 'claude',
      agents: [{ provider: 'claude', models }] }],
    threads: [{ id: 't', workspace_id: 'w', provider: 'claude', status: 'idle',
      updated_at: '2026-10-16T00:00:00Z',
      agent: { model_id: 'claude-opus-5-5', reasoning_effort: null } }],
  })
}

describe('thread model selection', () => {
  it.each(['opus', 'sonnet', 'haiku'])('resolves full %s IDs to the family option with the requested version', (family) => {
    expect(resolveModelOption(models, `claude-${family}-5-5`, 'claude')).toMatchObject({
      id: family, label: `${family[0].toUpperCase()}${family.slice(1)} 5.5`,
    })
  })

  it('keeps dated/pinned versions and respects explicit catalog names', () => {
    expect(resolveModelOption(models, 'claude-opus-4-6-20260101', 'claude')?.label).toBe('Opus 4.6')
    const custom = { ...models[1], id: 'claude-opus-5-5', label: 'Custom Opus' }
    expect(resolveModelOption([...models, custom], custom.id, 'claude')).toBe(custom)
    expect(resolveModelOption([{ ...custom, label: custom.id }], custom.id, 'claude')?.label).toBe('Opus 5.5')
  })

  it('preserves unknown model IDs instead of displaying the composer default', () => {
    expect(resolveModelOption(models, 'private-model', 'claude')).toMatchObject({
      id: 'private-model', label: 'private-model', default_reasoning_effort: null,
    })
    expect(resolveModelOption(models, 'claude-opus-5-5', 'codex')?.id).toBe('claude-opus-5-5')
    expect(resolveModelOption([], 'claude-opus-5-5', 'claude')?.label).toBe('Opus 5.5')
  })

  it('keeps a full-ID MCP thread and provider-default effort ahead of Sonnet/Low preferences', () => {
    const { threads: [thread], workspaces: [workspace] } = snapshot()
    expect(resolveThreadModelId(thread, workspace, 'sonnet')).toBe('claude-opus-5-5')
    expect(resolveReasoningEffort(thread, workspace, 'sonnet', 'low')).toBeNull()
    expect(defaultReasoningEffort(thread, workspace)).toBe('high')
    expect(reasoningOptions(thread, workspace)).toEqual(['low', 'medium', 'high'])
    const noModel = { ...thread, agent: { ...thread.agent, model_id: null } }
    expect(resolveThreadModelId(noModel, workspace, 'opus')).toBeNull()
    expect(resolveReasoningEffort(noModel, workspace, 'opus', 'low')).toBeNull()
    expect(resolveThreadModelId(null, workspace, 'sonnet')).toBe('sonnet')
    expect(resolveReasoningEffort(null, workspace, 'sonnet', 'low', 'claude')).toBe('low')
  })

  it('retains explicit effort even when a stale catalog does not list it', () => {
    const { threads: [thread], workspaces: [workspace] } = snapshot()
    thread.agent.reasoning_effort = 'max'
    expect(resolveReasoningEffort(thread, workspace, 'sonnet', 'low')).toBe('max')
  })

  it('survives reload, relay thread updates, resume status, and replacement snapshots', () => {
    let current = normalizeDaemonSnapshot(JSON.parse(JSON.stringify(snapshot())))
    const [workspace] = current.workspaces
    const check = () => {
      const [thread] = current.threads
      const modelId = resolveThreadModelId(thread, workspace, 'sonnet')
      expect(modelId).toBe('claude-opus-5-5')
      expect(resolveModelOption(models, modelId, thread.provider)?.label).toBe('Opus 5.5')
      expect(resolveReasoningEffort(thread, workspace, modelId, 'low')).toBeNull()
    }
    check()
    for (const status of ['running', 'idle'] as const) {
      const events = parseDaemonEvents({ kind: 'daemon-events', events: [{
        seq: 1, emitted_at: '2026-10-16T00:00:01Z', workspace_id: 'w', thread_id: 't',
        event: { type: 'thread-updated', thread: { ...current.threads[0], status } },
      }] })
      expect(events).toHaveLength(1)
      current = applySnapshotEvent(current, events[0])!
      check()
    }
    current = normalizeDaemonSnapshot(JSON.parse(JSON.stringify(current)))
    check()
  })

  it('reseeds existing threads on remote settings changes without resetting on activity', () => {
    const { threads: [thread] } = snapshot()
    const before = threadComposerSelectionKey('w', thread)
    expect(threadComposerSelectionKey('w', { ...thread, status: 'running' })).toBe(before)
    expect(threadComposerSelectionKey('w', { ...thread, agent: { ...thread.agent, permission_mode: 'auto' } })).toBe(before)
    expect(threadComposerSelectionKey('w', { ...thread, agent: { ...thread.agent, model_id: 'sonnet' } })).not.toBe(before)
    expect(threadComposerSelectionKey('w', { ...thread, agent: { ...thread.agent, reasoning_effort: 'high' } })).not.toBe(before)
  })
})
