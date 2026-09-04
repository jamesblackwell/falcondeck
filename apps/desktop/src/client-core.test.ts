import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'

import {
  applyEventToThreadDetail,
  applySnapshotEvent,
  bootstrapSessionCrypto,
  buildProjectGroups,
  bytesToBase64,
  conversationItemsForSelection,
  decryptJson,
  deriveThreadAttentionPresentation,
  deriveIdentityKeyPair,
  encryptJson,
  generateBoxKeyPair,
  identityPublicKeyToBase64,
  normalizePreferences,
  normalizeConversationItem,
  normalizeThreadSummary,
  normalizeWorkspaceSummary,
  projectLabel,
  publicKeyToBase64,
  reconcileSnapshotSelection,
  REMOTE_SESSION_STORAGE_VERSION,
  selectedSkillsFromText,
  activeSlashQuery,
  shouldReusePersistedRemoteSession,
  signPairingClaimChallenge,
  upsertConversationItem,
  verifyPairingClaimChallenge,
  formatModelLabel,
  filesToImageInputs,
  modelFastTier,
  anyModelHasFastTier,
  resolveServiceTier,
  serviceTierForTurn,
  threadForSelection,
  STANDARD_SERVICE_TIER,
  workspaceAgentCapabilities,
  workspaceProviderOptions,
  type ConversationItem,
  type ModelSummary,
  type EventEnvelope,
  type InteractiveRequest,
  type PersistedRemoteSession,
  type SessionKeyMaterial,
  type ThreadDetail,
  type ThreadSummary,
  type WorkspaceSummary,
} from '@falcondeck/client-core'

describe('client-core image inputs', () => {
  it('rejects unsupported files explicitly instead of silently discarding them', async () => {
    const files = [{ name: 'notes.txt', type: 'text/plain' }] as unknown as FileList
    let message = ''
    try {
      await filesToImageInputs(files)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe('Only image attachments are supported. notes.txt was not attached.')
  })
})

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
    connected_at: '2026-03-15T10:00:00Z',
    updated_at: '2026-03-15T10:00:00Z',
    last_error: null,
    ...overrides,
  }
}

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'thread-1',
    workspace_id: 'workspace-1',
    title: 'Main thread',
    provider: 'codex',
    native_session_id: null,
    status: 'idle',
    updated_at: '2026-03-15T10:00:00Z',
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    is_archived: false,
    is_pinned: false,
    is_pinned_in_project: false,
    goal: null,
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
    ...overrides,
  }
}

function assistantMessage(
  id: string,
  created_at: string,
  text: string,
): ConversationItem {
  return {
    kind: 'assistant_message',
    id,
    text,
    created_at,
  }
}

describe('client-core grouping', () => {
  it('groups threads by workspace and sorts them by latest update', () => {
    const alpha = workspace({ id: 'alpha', path: '/tmp/alpha' })
    const beta = workspace({ id: 'beta', path: '/tmp/beta' })
    const groups = buildProjectGroups(
      [beta, alpha],
      [
        thread({ id: 'alpha-old', workspace_id: 'alpha', updated_at: '2026-03-15T08:00:00Z' }),
        thread({ id: 'alpha-new', workspace_id: 'alpha', updated_at: '2026-03-15T09:00:00Z' }),
        thread({ id: 'beta-only', workspace_id: 'beta', updated_at: '2026-03-15T07:00:00Z' }),
      ],
    )

    expect(groups.map((group) => group.workspace.id)).toEqual(['alpha', 'beta'])
    expect(groups[0].threads.map((entry) => entry.id)).toEqual(['alpha-new', 'alpha-old'])
    expect(groups[1].threads.map((entry) => entry.id)).toEqual(['beta-only'])
  })

  it('extracts a friendly project label from a path', () => {
    expect(projectLabel('/Users/james/work/falcondeck')).toBe('falcondeck')
    expect(projectLabel('falcondeck')).toBe('falcondeck')
  })
})

describe('client-core provider normalization', () => {
  it('keeps unknown provider ids instead of relabelling them as codex', () => {
    const normalized = normalizeWorkspaceSummary({
      id: 'workspace-1',
      path: '/tmp/alpha',
      agents: [{ provider: 'grok', account: { status: 'ready', label: 'ready' } }],
      default_provider: 'grok',
    })

    expect(normalized.agents.map((agent) => agent.provider)).toEqual(['grok'])
    expect(normalized.default_provider).toBe('grok')
    expect(normalizeThreadSummary({ id: 't1', provider: 'grok' }).provider).toBe('grok')
  })

  it('falls back to codex only when the provider is missing or blank', () => {
    expect(normalizeThreadSummary({ id: 't1' }).provider).toBe('codex')
    expect(normalizeThreadSummary({ id: 't1', provider: '' }).provider).toBe('codex')
    expect(normalizeThreadSummary({ id: 't1', provider: null }).provider).toBe('codex')
  })

  it('derives a label for providers the daemon does not name', () => {
    const normalized = normalizeWorkspaceSummary({
      id: 'workspace-1',
      path: '/tmp/alpha',
      agents: [
        { provider: 'grok', account: { status: 'ready', label: 'ready' } },
        { provider: 'claude', label: 'Claude Code', account: { status: 'ready', label: 'ready' } },
      ],
    })

    expect(workspaceProviderOptions(normalized)).toEqual([
      { provider: 'grok', label: 'Grok' },
      { provider: 'claude', label: 'Claude Code' },
    ])
  })

  it('defaults unreported capabilities to off and empty mode lists', () => {
    const normalized = normalizeWorkspaceSummary({
      id: 'workspace-1',
      path: '/tmp/alpha',
      agents: [
        {
          provider: 'grok',
          account: { status: 'ready', label: 'ready' },
          capabilities: { supports_goals: true, sandbox_modes: ['sealed', 42] },
        },
      ],
    })

    expect(workspaceAgentCapabilities(normalized, 'grok')).toEqual({
      supports_review: false,
      supports_goals: true,
      supports_images: false,
      supports_skills: false,
      supports_interrupt: false,
      supports_steering: false,
      supports_forking: false,
      supports_compaction: false,
      supports_compaction_instructions: false,
      sandbox_modes: ['sealed'],
      permission_modes: [],
    })
    // A provider the workspace never mentions reports nothing.
    expect(workspaceAgentCapabilities(normalized, 'codex').supports_goals).toBe(false)
  })
})

describe('selection boundaries', () => {
  it('does not resolve a thread from another workspace', () => {
    const alpha = thread({ id: 'shared-thread', workspace_id: 'alpha' })
    const beta = thread({ id: 'shared-thread', workspace_id: 'beta' })

    expect(threadForSelection([alpha, beta], 'alpha', 'shared-thread')).toBe(alpha)
    expect(threadForSelection([alpha, beta], 'gamma', 'shared-thread')).toBeNull()
    expect(threadForSelection([alpha, beta], 'alpha', null)).toBeNull()
  })

  it('does not count another workspace\'s pending request as thread attention', () => {
    const threadInAlpha = thread({ id: 'shared-thread', workspace_id: 'alpha' })
    const foreignApproval = {
      request_id: 'approval-1',
      workspace_id: 'beta',
      thread_id: 'shared-thread',
      method: 'tool.call',
      kind: 'approval',
      approval_decisions: ['allow', 'deny'] as const,
      title: 'Run command',
      detail: null,
      command: null,
      path: null,
      turn_id: null,
      item_id: null,
      questions: [],
      created_at: '2026-03-15T10:00:00Z',
    } satisfies InteractiveRequest

    expect(
      deriveThreadAttentionPresentation(threadInAlpha, [foreignApproval])
        .pendingApprovalCount,
    ).toBe(0)
  })
})

describe('client-core skills helpers', () => {
  it('normalizes model labels to lowercase for display', () => {
    expect(formatModelLabel('GPT-5.4-Mini')).toBe('gpt-5.4-mini')
    expect(formatModelLabel('Sonnet 4.6')).toBe('sonnet 4.6')
  })

  it('parses selected skills from slash aliases without treating paths as skills', () => {
    const skills = [
      {
        id: 'skill:search-web',
        label: 'Search Web',
        alias: '/search-web',
        availability: 'both' as const,
        source_kind: 'project_file' as const,
      },
      {
        id: 'skill:review',
        label: 'Review',
        alias: '/review',
        availability: 'codex' as const,
        source_kind: 'provider_native' as const,
      },
    ]

    expect(
      selectedSkillsFromText(
        'Use /search-web for context and inspect /Users/james/falcondeck afterwards.',
        skills,
      ),
    ).toEqual([{ skill_id: 'skill:search-web', alias: '/search-web' }])
    expect(selectedSkillsFromText('/search-web/docs', skills)).toEqual([])
  })

  it('detects an active slash query near the caret', () => {
    expect(activeSlashQuery('Please run /search', 'Please run /search'.length)).toEqual({
      query: 'search',
      rangeStart: 11,
      rangeEnd: 18,
    })
    expect(activeSlashQuery('/Users/james/project', '/Users/james/project'.length)).toBeNull()
  })
})

describe('client-core conversation helpers', () => {
  it('upserts by kind and id while keeping chronological order', () => {
    const items = upsertConversationItem(
      [assistantMessage('a', '2026-03-15T10:01:00Z', 'second')],
      assistantMessage('b', '2026-03-15T10:00:00Z', 'first'),
    )

    expect(items.map((item) => item.id)).toEqual(['b', 'a'])

    const updated = upsertConversationItem(items, assistantMessage('a', '2026-03-15T10:01:00Z', 'updated'))
    expect(updated).toHaveLength(2)
    expect(updated[1]).toMatchObject({ id: 'a', text: 'updated' })
  })

  // Identity must be checked even for newer timestamps: Claude/ACP re-emit
  // whole items with a fresh created_at on every update, so an unchecked
  // "newer → append" fast path duplicates streaming items. The batched frame
  // path amortizes this scan through its identity map.
  it('appends newer items and dedupes re-emitted ones with fresh timestamps', () => {
    const items = [assistantMessage('a', '2026-03-15T10:00:00Z', 'first')]

    const appended = upsertConversationItem(
      items,
      assistantMessage('b', '2026-03-15T10:01:00Z', 'second'),
    )
    expect(appended.map((item) => item.id)).toEqual(['a', 'b'])

    const restamped = upsertConversationItem(
      appended,
      assistantMessage('a', '2026-03-15T10:02:00Z', 'first updated'),
    )
    expect(restamped.map((item) => item.id)).toEqual(['a', 'b'])
    expect(restamped[0]).toMatchObject({
      id: 'a',
      text: 'first updated',
      created_at: '2026-03-15T10:00:00Z',
    })
  })

  it('updates an earlier item with a tied timestamp without duplicating it', () => {
    const items = [
      assistantMessage('a', '2026-03-15T10:00:00Z', 'first'),
      assistantMessage('b', '2026-03-15T10:00:00Z', 'second'),
    ]

    const updated = upsertConversationItem(
      items,
      assistantMessage('a', '2026-03-15T10:00:00Z', 'edited'),
    )

    expect(updated).toHaveLength(2)
    expect(updated.map((item) => item.id)).toEqual(['a', 'b'])
    expect(updated[0]).toMatchObject({ id: 'a', text: 'edited' })
  })

  it('appends a new item with a tied timestamp exactly once', () => {
    const items = [assistantMessage('a', '2026-03-15T10:00:00Z', 'first')]

    const updated = upsertConversationItem(
      items,
      assistantMessage('b', '2026-03-15T10:00:00Z', 'second'),
    )

    expect(updated.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('updates the streaming tail item without scanning the full array', () => {
    const spy = vi.spyOn(Array.prototype, 'findIndex')
    const items = [
      assistantMessage('a', '2026-03-15T10:00:00Z', 'first'),
      assistantMessage('b', '2026-03-15T10:01:00Z', 'working'),
    ]

    const updated = upsertConversationItem(
      items,
      assistantMessage('b', '2026-03-15T10:01:00Z', 'done'),
    )

    expect(updated[1]).toMatchObject({ id: 'b', text: 'done' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('applies thread and conversation updates only to the matching thread detail', () => {
    const detail: ThreadDetail = {
      workspace: workspace(),
      thread: thread(),
      items: [assistantMessage('a', '2026-03-15T10:00:00Z', 'hello')],
      has_older: false,
      oldest_item_id: 'a',
      newest_item_id: 'a',
      is_partial: false,
    }
    const updatedThread = thread({ status: 'running', last_message_preview: 'working' })
    const event: EventEnvelope = {
      seq: 2,
      emitted_at: '2026-03-15T10:05:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'thread-updated',
        thread: updatedThread,
      },
    }

    const next = applyEventToThreadDetail(detail, event)
    expect(next?.thread.status).toBe('running')

    const itemEvent: EventEnvelope = {
      seq: 3,
      emitted_at: '2026-03-15T10:06:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'conversation-item-added',
        item: assistantMessage('b', '2026-03-15T10:06:00Z', 'done'),
      },
    }

    expect(applyEventToThreadDetail(next, itemEvent)?.items.map((item) => item.id)).toEqual(['a', 'b'])

    const otherThreadEvent: EventEnvelope = {
      ...itemEvent,
      thread_id: 'thread-2',
    }
    expect(applyEventToThreadDetail(detail, otherThreadEvent)).toBe(detail)
  })

  it('returns the original detail reference for event types it does not handle', () => {
    const detail: ThreadDetail = {
      workspace: workspace(),
      thread: thread(),
      items: [assistantMessage('a', '2026-03-15T10:00:00Z', 'hello')],
      has_older: false,
      oldest_item_id: 'a',
      newest_item_id: 'a',
      is_partial: false,
    }

    // Per-token streaming deltas target the matching thread but are not
    // applied here; they must not allocate a new ThreadDetail.
    const textDelta: EventEnvelope = {
      seq: 7,
      emitted_at: '2026-03-15T10:07:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: { type: 'text', item_id: 'item-1', delta: 'tok' },
    }
    expect(applyEventToThreadDetail(detail, textDelta)).toBe(detail)

    const turnStart: EventEnvelope = {
      seq: 8,
      emitted_at: '2026-03-15T10:08:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: { type: 'turn-start', turn_id: 'turn-1' },
    }
    expect(applyEventToThreadDetail(detail, turnStart)).toBe(detail)
  })

  it('applies workspace metadata updates to both snapshots and active thread detail', () => {
    const updatedWorkspace = workspace({
      updated_at: '2026-03-15T10:10:00Z',
      models: [
        {
          id: 'gpt-5.4',
          label: 'GPT-5.4',
          is_default: true,
          default_reasoning_effort: 'medium',
          supported_reasoning_efforts: [],
        },
      ],
    })
    const event: EventEnvelope = {
      seq: 4,
      emitted_at: '2026-03-15T10:10:00Z',
      workspace_id: 'workspace-1',
      thread_id: null,
      event: {
        type: 'workspace-updated',
        workspace: updatedWorkspace,
      },
    }

    const snapshot = {
      daemon: { version: '0.1.0', started_at: '2026-03-15T10:00:00Z' },
      workspaces: [workspace()],
      threads: [thread()],
      interactive_requests: [],
      preferences: normalizePreferences(null),
    }
    expect(applySnapshotEvent(snapshot, event)?.workspaces[0]?.models[0]?.id).toBe('gpt-5.4')

    const detail: ThreadDetail = {
      workspace: workspace(),
      thread: thread(),
      items: [],
      has_older: false,
      oldest_item_id: null,
      newest_item_id: null,
      is_partial: false,
    }
    expect(applyEventToThreadDetail(detail, event)?.workspace.updated_at).toBe(
      '2026-03-15T10:10:00Z',
    )
  })

  it('retains and deduplicates workspace service notices outside transcripts', () => {
    const snapshot = {
      daemon: { version: '0.1.0', started_at: '2026-03-15T10:00:00Z' },
      workspaces: [workspace()],
      threads: [thread()],
      interactive_requests: [],
      service_notices: [],
      preferences: normalizePreferences(null),
    }
    const event: EventEnvelope = {
      seq: 5,
      emitted_at: '2026-03-15T10:11:00Z',
      workspace_id: 'workspace-1',
      thread_id: null,
      event: {
        type: 'service',
        level: 'warning',
        message: 'Configuration will change in the next release.',
        raw_method: 'deprecationNotice',
        notice: {
          id: 'notice-1',
          workspace_id: 'workspace-1',
          level: 'warning',
          message: 'Configuration will change in the next release.',
          raw_method: 'deprecationNotice',
          created_at: '2026-03-15T10:11:00Z',
        },
      },
    }

    const withNotice = applySnapshotEvent(snapshot, event)
    expect(withNotice?.service_notices).toHaveLength(1)
    expect(applySnapshotEvent(withNotice, event)).toBe(withNotice)
  })

  it('updates token usage independently of thread state', () => {
    const snapshot = {
      daemon: { version: '0.1.0', started_at: '2026-03-15T10:00:00Z' },
      workspaces: [workspace()],
      threads: [thread()],
      interactive_requests: [],
      preferences: normalizePreferences(null),
    }
    const event: EventEnvelope = {
      seq: 6,
      emitted_at: '2026-03-15T10:12:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'thread-token-usage-updated',
        usage: {
          total: {
            total_tokens: 116_000,
            input_tokens: 100_000,
            cached_input_tokens: 50_000,
            output_tokens: 12_000,
            reasoning_output_tokens: 4_000,
          },
          last: null,
          model_context_window: 128_000,
          updated_at: '2026-03-15T10:12:00Z',
        },
      },
    }

    const updated = applySnapshotEvent(snapshot, event)
    expect(updated?.threads).toBe(snapshot.threads)
    expect(updated?.thread_token_usage?.['thread-1']).toMatchObject({
      total: { total_tokens: 116_000 },
      model_context_window: 128_000,
    })
  })

  it('inserts a missing thread on thread-updated instead of dropping the event', () => {
    const snapshot = {
      daemon: { version: '0.1.0', started_at: '2026-03-15T10:00:00Z' },
      workspaces: [workspace()],
      threads: [thread()],
      interactive_requests: [],
      preferences: normalizePreferences(null),
    }
    const missedThread = thread({
      id: 'thread-2',
      title: 'Missed thread',
      updated_at: '2026-03-15T11:00:00Z',
    })
    const event: EventEnvelope = {
      seq: 5,
      emitted_at: '2026-03-15T11:00:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-2',
      event: {
        type: 'thread-updated',
        thread: missedThread,
      },
    }

    const next = applySnapshotEvent(snapshot, event)
    expect(next?.threads.map((entry) => entry.id)).toEqual(['thread-2', 'thread-1'])

    const updateEvent: EventEnvelope = {
      ...event,
      seq: 6,
      event: {
        type: 'thread-updated',
        thread: thread({ id: 'thread-2', title: 'Renamed', updated_at: '2026-03-15T11:05:00Z' }),
      },
    }
    const renamed = applySnapshotEvent(next, updateEvent)
    expect(renamed?.threads).toHaveLength(2)
    expect(renamed?.threads.find((entry) => entry.id === 'thread-2')?.title).toBe('Renamed')
  })

  it('does not resurrect an archived thread from a late thread-updated event', () => {
    const snapshot = {
      daemon: { version: '0.1.0', started_at: '2026-03-15T10:00:00Z' },
      workspaces: [workspace()],
      threads: [thread()],
      interactive_requests: [],
      preferences: normalizePreferences(null),
    }
    // e.g. mark_read lands after the thread was archived (and thus dropped
    // from the snapshot); the unknown-id insert must not bring it back.
    const event: EventEnvelope = {
      seq: 7,
      emitted_at: '2026-03-15T11:10:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-archived',
      event: {
        type: 'thread-updated',
        thread: thread({ id: 'thread-archived', is_archived: true }),
      },
    }

    expect(applySnapshotEvent(snapshot, event)?.threads.map((entry) => entry.id)).toEqual([
      'thread-1',
    ])
  })

  it('keeps a thread in the snapshot when an update archives it', () => {
    const snapshot = {
      daemon: { version: '0.1.0', started_at: '2026-03-15T10:00:00Z' },
      workspaces: [workspace()],
      threads: [thread(), thread({ id: 'thread-2' })],
      interactive_requests: [],
      preferences: normalizePreferences(null),
    }
    const event: EventEnvelope = {
      seq: 8,
      emitted_at: '2026-03-15T11:20:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: {
        type: 'thread-updated',
        thread: thread({ id: 'thread-1', is_archived: true }),
      },
    }

    const next = applySnapshotEvent(snapshot, event)
    expect(next?.threads.map((entry) => entry.id)).toEqual(['thread-1', 'thread-2'])
    expect(next?.threads.find((entry) => entry.id === 'thread-1')?.is_archived).toBe(true)
  })

  it('normalizes raw tool-call items delivered through conversation-item events', () => {
    const detail: ThreadDetail = {
      workspace: workspace(),
      thread: thread(),
      items: [],
      has_older: false,
      oldest_item_id: null,
      newest_item_id: null,
      is_partial: false,
    }
    // Simulates a daemon payload whose tool_call display is missing entirely;
    // the shared event normalizer repairs it before insertion.
    const rawItem = {
      kind: 'tool_call',
      id: 'tool-1',
      title: 'bash',
      tool_kind: 'bash',
      status: 'completed',
      output: null,
      exit_code: null,
      created_at: '2026-03-15T10:06:00Z',
      completed_at: null,
    } as unknown as ConversationItem
    const event: EventEnvelope = {
      seq: 9,
      emitted_at: '2026-03-15T10:06:00Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: { type: 'conversation-item-added', item: rawItem },
    }

    const next = applyEventToThreadDetail(detail, event)
    const inserted = next?.items.find((item) => item.id === 'tool-1')
    expect(inserted?.kind).toBe('tool_call')
    expect(inserted && inserted.kind === 'tool_call' ? inserted.display : null).toMatchObject({
      is_read_only: false,
      activity_kind: 'other',
      history_mode: 'full',
    })
  })

  it('downgrades approval artifacts on tools that merely mention permissions', () => {
    const readItem = {
      kind: 'tool_call',
      id: 'read-1',
      title: 'Read /project/src/index.tsx',
      tool_kind: 'fileRead',
      status: 'completed',
      output: 'const mode = resolvePermissionMode(preferred.permissionMode)',
      exit_code: 0,
      display: {
        is_read_only: true,
        has_side_effect: false,
        is_error: false,
        artifact_kind: 'approval_related',
        activity_kind: 'approval',
        history_mode: 'full',
        summary_hint: null,
      },
      created_at: '2026-03-15T10:06:00Z',
      completed_at: '2026-03-15T10:06:01Z',
    } satisfies ConversationItem

    const normalized = normalizeConversationItem(readItem)
    expect(normalized.kind === 'tool_call' ? normalized.display : null).toMatchObject({
      artifact_kind: 'command_output',
      activity_kind: 'other',
    })
  })

  it('keeps approval artifacts for genuine approval traffic', () => {
    const denied = {
      kind: 'tool_call',
      id: 'bash-1',
      title: 'Bash npm install',
      tool_kind: 'commandExecution',
      status: 'failed',
      output: 'This command requested permissions to run.',
      exit_code: 1,
      display: {
        is_read_only: false,
        has_side_effect: true,
        is_error: true,
        artifact_kind: 'approval_related',
        activity_kind: 'approval',
        history_mode: 'full',
        summary_hint: null,
      },
      created_at: '2026-03-15T10:06:00Z',
      completed_at: '2026-03-15T10:06:01Z',
    } satisfies ConversationItem

    const normalized = normalizeConversationItem(denied)
    expect(normalized.kind === 'tool_call' ? normalized.display : null).toMatchObject({
      artifact_kind: 'approval_related',
      activity_kind: 'approval',
    })
  })

  it('hides skill markdown bodies from normalized history and live events', () => {
    const skillItem = {
      kind: 'tool_call',
      id: 'skill-read-1',
      title: 'Read /project/.agents/skills/review/SKILL.md',
      tool_kind: 'read',
      status: 'completed',
      output: '# Review\n\nPrivate instructions',
      exit_code: 0,
      display: {
        is_read_only: true,
        has_side_effect: false,
        is_error: false,
        artifact_kind: 'command_output',
        activity_kind: 'read',
        history_mode: 'summary',
        summary_hint: null,
      },
      created_at: '2026-03-15T10:06:00Z',
      completed_at: '2026-03-15T10:06:01Z',
    } satisfies ConversationItem

    expect(normalizeConversationItem(skillItem)).toMatchObject({ output: null })

    const detail: ThreadDetail = {
      workspace: workspace(),
      thread: thread(),
      items: [],
      has_older: false,
      oldest_item_id: null,
      newest_item_id: null,
      is_partial: false,
    }
    const event: EventEnvelope = {
      seq: 10,
      emitted_at: '2026-03-15T10:06:01Z',
      workspace_id: 'workspace-1',
      thread_id: 'thread-1',
      event: { type: 'conversation-item-added', item: skillItem },
    }

    const inserted = applyEventToThreadDetail(detail, event)?.items[0]
    expect(inserted?.kind === 'tool_call' ? inserted.output : 'missing').toBeNull()
  })

  it('returns no conversation items for a new thread composer', () => {
    const detail: ThreadDetail = {
      workspace: workspace(),
      thread: thread(),
      items: [assistantMessage('a', '2026-03-15T10:00:00Z', 'hello')],
      has_older: false,
      oldest_item_id: 'a',
      newest_item_id: 'a',
      is_partial: false,
    }

    expect(conversationItemsForSelection('workspace-1', null, detail)).toEqual([])
  })

  it('ignores stale thread detail from another thread and uses fallback items', () => {
    const detail: ThreadDetail = {
      workspace: workspace(),
      thread: thread(),
      items: [assistantMessage('a', '2026-03-15T10:00:00Z', 'stale')],
      has_older: false,
      oldest_item_id: 'a',
      newest_item_id: 'a',
      is_partial: false,
    }
    const fallback = [assistantMessage('b', '2026-03-15T10:01:00Z', 'fresh')]

    expect(
      conversationItemsForSelection('workspace-1', 'thread-2', detail, fallback),
    ).toEqual(fallback)
  })
})

describe('client-core relay crypto helpers', () => {
  it('encrypts and decrypts JSON payloads with the shared session key', async () => {
    const dataKey = crypto.getRandomValues(new Uint8Array(32))
    const envelope = await encryptJson(dataKey, { hello: 'world' })
    await expect(decryptJson<{ hello: string }>(dataKey, envelope)).resolves.toEqual({ hello: 'world' })
  })

  it.skip('unwraps bootstrap material into usable session crypto state', async () => {
    const daemonKeyPair = generateBoxKeyPair()
    const clientKeyPair = generateBoxKeyPair()
    const dataKey = crypto.getRandomValues(new Uint8Array(32))
    const nonce = crypto.getRandomValues(new Uint8Array(24))
    const ciphertext = nacl.box(
      dataKey,
      nonce,
      clientKeyPair.publicKey,
      daemonKeyPair.secretKey,
    )

    const material: SessionKeyMaterial = {
      encryption_variant: 'data_key_v1',
      identity_variant: 'ed25519_v1',
      pairing_id: 'pairing-1',
      session_id: 'session-1',
      daemon_public_key: publicKeyToBase64(daemonKeyPair),
      daemon_identity_public_key: identityPublicKeyToBase64(deriveIdentityKeyPair(daemonKeyPair)),
      client_public_key: publicKeyToBase64(clientKeyPair),
      client_identity_public_key: identityPublicKeyToBase64(deriveIdentityKeyPair(clientKeyPair)),
      client_wrapped_data_key: {
        encryption_variant: 'data_key_v1',
        wrapped_key: bytesToBase64(new Uint8Array([0, ...daemonKeyPair.publicKey, ...nonce, ...ciphertext])),
      },
      daemon_wrapped_data_key: null,
      signature: '',
    }

    const payload = new Uint8Array(new TextEncoder().encode(
      `falcondeck-session-bootstrap-v1\ndata_key_v1\ned25519_v1\n${material.pairing_id}\n${material.session_id}\n${material.daemon_public_key}\n${material.daemon_identity_public_key}\n${material.client_public_key}\n${material.client_identity_public_key}\n${material.client_wrapped_data_key.wrapped_key}\n`,
    ))
    material.signature = bytesToBase64(
      nacl.sign.detached(payload, new Uint8Array(deriveIdentityKeyPair(daemonKeyPair).secretKey)),
    )

    const sessionCrypto = bootstrapSessionCrypto(clientKeyPair, material, {
      expectedDaemonPublicKey: material.daemon_public_key,
      expectedDaemonIdentityPublicKey: material.daemon_identity_public_key,
    })
    const envelope = await encryptJson(sessionCrypto.dataKey, { secure: true })
    await expect(decryptJson<{ secure: boolean }>(sessionCrypto.dataKey, envelope)).resolves.toEqual({ secure: true })
  })

  it('rejects bootstrap material for a different client key', () => {
    const daemonKeyPair = generateBoxKeyPair()
    const clientKeyPair = generateBoxKeyPair()
    const otherClientKeyPair = generateBoxKeyPair()
    const nonce = crypto.getRandomValues(new Uint8Array(24))
    const dataKey = crypto.getRandomValues(new Uint8Array(32))
    const ciphertext = nacl.box(
      dataKey,
      nonce,
      clientKeyPair.publicKey,
      daemonKeyPair.secretKey,
    )

    const material: SessionKeyMaterial = {
      encryption_variant: 'data_key_v1',
      identity_variant: 'ed25519_v1',
      pairing_id: 'pairing-1',
      session_id: 'session-1',
      daemon_public_key: publicKeyToBase64(daemonKeyPair),
      daemon_identity_public_key: identityPublicKeyToBase64(deriveIdentityKeyPair(daemonKeyPair)),
      client_public_key: publicKeyToBase64(otherClientKeyPair),
      client_identity_public_key: identityPublicKeyToBase64(deriveIdentityKeyPair(otherClientKeyPair)),
      client_wrapped_data_key: {
        encryption_variant: 'data_key_v1',
        wrapped_key: bytesToBase64(new Uint8Array([0, ...daemonKeyPair.publicKey, ...nonce, ...ciphertext])),
      },
      daemon_wrapped_data_key: null,
      signature: '',
    }

    const payload = new Uint8Array(new TextEncoder().encode(
      `falcondeck-session-bootstrap-v1\ndata_key_v1\ned25519_v1\n${material.pairing_id}\n${material.session_id}\n${material.daemon_public_key}\n${material.daemon_identity_public_key}\n${material.client_public_key}\n${material.client_identity_public_key}\n${material.client_wrapped_data_key.wrapped_key}\n`,
    ))
    material.signature = bytesToBase64(
      nacl.sign.detached(payload, new Uint8Array(deriveIdentityKeyPair(daemonKeyPair).secretKey)),
    )

    expect(() => bootstrapSessionCrypto(clientKeyPair, material, {
      expectedDaemonPublicKey: material.daemon_public_key,
      expectedDaemonIdentityPublicKey: material.daemon_identity_public_key,
    })).toThrow(
      'Encrypted session bootstrap is not addressed to this client',
    )
  })
})

describe('client-core pairing claim challenge signing', () => {
  it('signs the Rust-compatible payload string and round-trips verification', () => {
    const keyPair = generateBoxKeyPair()
    const identityKeyPair = deriveIdentityKeyPair(keyPair)
    const pairingCode = 'PAIRCODE1234'
    const challenge = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))

    const signature = signPairingClaimChallenge(keyPair, pairingCode, challenge)

    // The signature must cover the exact payload byte string the Rust relay
    // verifies: `falcondeck-pairing-claim-v1\n{pairing_code}\n{challenge}`.
    const payload = new Uint8Array(
      new TextEncoder().encode(`falcondeck-pairing-claim-v1\n${pairingCode}\n${challenge}`),
    )
    expect(
      nacl.sign.detached.verify(
        payload,
        new Uint8Array([...atob(signature)].map((char) => char.charCodeAt(0))),
        identityKeyPair.publicKey,
      ),
    ).toBe(true)

    expect(() =>
      verifyPairingClaimChallenge(
        identityPublicKeyToBase64(identityKeyPair),
        pairingCode,
        challenge,
        signature,
      ),
    ).not.toThrow()
  })

  it('rejects a signature made by a different identity key', () => {
    const keyPair = generateBoxKeyPair()
    const otherKeyPair = generateBoxKeyPair()
    const pairingCode = 'PAIRCODE1234'
    const challenge = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))

    const signature = signPairingClaimChallenge(otherKeyPair, pairingCode, challenge)

    expect(() =>
      verifyPairingClaimChallenge(
        identityPublicKeyToBase64(deriveIdentityKeyPair(keyPair)),
        pairingCode,
        challenge,
        signature,
      ),
    ).toThrow('Pairing claim challenge signature verification failed')
  })

  it('rejects a signature over a different pairing code or challenge', () => {
    const keyPair = generateBoxKeyPair()
    const identityPublicKey = identityPublicKeyToBase64(deriveIdentityKeyPair(keyPair))
    const challenge = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    const signature = signPairingClaimChallenge(keyPair, 'PAIRCODE1234', challenge)

    expect(() =>
      verifyPairingClaimChallenge(identityPublicKey, 'OTHERCODE999', challenge, signature),
    ).toThrow('Pairing claim challenge signature verification failed')
    expect(() =>
      verifyPairingClaimChallenge(
        identityPublicKey,
        'PAIRCODE1234',
        bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
        signature,
      ),
    ).toThrow('Pairing claim challenge signature verification failed')
  })
})

describe('client-core remote session persistence', () => {
  it('does not let an unreviewed pairing link replace a saved session', () => {
    const persisted = {
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.falcondeck.com',
      pairingCode: 'OLDPAIR123456',
      sessionId: 'session-old',
      clientToken: 'client-old',
      clientSecretKey: 'secret',
    } satisfies PersistedRemoteSession

    const params = new URLSearchParams({
      relay: 'https://connect.falcondeck.com',
      code: 'NEWPAIR654321',
    })

    expect(shouldReusePersistedRemoteSession(params, persisted)).toEqual(persisted)
  })

  it('reuses a saved session when the URL does not override it', () => {
    const persisted = {
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.falcondeck.com',
      pairingCode: 'PAIRCODE1234',
      sessionId: 'session-1',
      clientToken: 'client-1',
      clientSecretKey: 'secret',
    } satisfies PersistedRemoteSession

    expect(shouldReusePersistedRemoteSession(new URLSearchParams(), persisted)).toEqual(persisted)
  })

  it('does not let an unreviewed default-relay link replace a saved custom-relay session', () => {
    const persisted = {
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://staging-connect.falcondeck.com',
      pairingCode: 'PAIRCODE1234',
      sessionId: 'session-1',
      clientToken: 'client-1',
      clientSecretKey: 'secret',
    } satisfies PersistedRemoteSession

    const params = new URLSearchParams({
      code: 'PAIRCODE1234',
    })

    expect(shouldReusePersistedRemoteSession(params, persisted)).toEqual(persisted)
  })

  it('ignores a saved session from an older persistence version', () => {
    const persisted = {
      version: 1,
      relayUrl: 'https://connect.falcondeck.com',
      pairingCode: 'PAIRCODE1234',
      sessionId: 'session-1',
      clientToken: 'client-1',
      clientSecretKey: 'secret',
    } as unknown as Parameters<typeof shouldReusePersistedRemoteSession>[1]

    expect(shouldReusePersistedRemoteSession(new URLSearchParams(), persisted)).toBeNull()
  })
})

describe('client-core service tier helpers', () => {
  const fastModel: ModelSummary = {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    is_default: true,
    default_reasoning_effort: 'medium',
    supported_reasoning_efforts: [],
    service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
    default_service_tier: null,
  }
  const plainModel: ModelSummary = {
    id: 'sonnet',
    label: 'Sonnet 5',
    is_default: true,
    default_reasoning_effort: 'medium',
    supported_reasoning_efforts: [],
  }

  it('finds the fast tier only on models that advertise one', () => {
    expect(modelFastTier(fastModel)?.id).toBe('priority')
    expect(modelFastTier(plainModel)).toBeNull()
    expect(anyModelHasFastTier([plainModel, fastModel])).toBe(true)
    expect(anyModelHasFastTier([plainModel])).toBe(false)
  })

  it('validates tiers against the model catalog and treats the standard tier as off', () => {
    expect(resolveServiceTier('priority', fastModel)).toBe('priority')
    expect(resolveServiceTier(STANDARD_SERVICE_TIER, fastModel)).toBeNull()
    expect(resolveServiceTier('priority', plainModel)).toBeNull()
    expect(resolveServiceTier('retired-tier', fastModel)).toBeNull()
    expect(resolveServiceTier(null, fastModel)).toBeNull()
  })

  it('states the tier explicitly on turns for tier-capable models and omits it otherwise', () => {
    expect(serviceTierForTurn('priority', fastModel)).toBe('priority')
    // Off must reach the provider as an explicit standard-tier request, not
    // an absent field, because absent means "keep the session's tier".
    expect(serviceTierForTurn(null, fastModel)).toBe(STANDARD_SERVICE_TIER)
    expect(serviceTierForTurn('priority', plainModel)).toBeNull()
    expect(serviceTierForTurn(null, plainModel)).toBeNull()
  })
})

describe('client-core selection reconciliation', () => {
  it('falls back to the restored current thread when a stale selection disappears', () => {
    const currentWorkspace = workspace({
      id: 'workspace-2',
      path: '/Users/james/quizgecko',
      current_thread_id: 'thread-2',
      updated_at: '2026-03-15T12:00:00Z',
    })
    const currentThread = thread({
      id: 'thread-2',
      workspace_id: 'workspace-2',
      updated_at: '2026-03-15T12:00:00Z',
    })
    const snapshot = {
      daemon: { version: '0.1.0', started_at: '2026-03-15T10:00:00Z' },
      workspaces: [workspace(), currentWorkspace],
      threads: [currentThread, thread()],
      interactive_requests: [],
      preferences: normalizePreferences(null),
    }

    expect(
      reconcileSnapshotSelection(snapshot, 'workspace-stale', 'thread-stale'),
    ).toEqual({
      workspaceId: 'workspace-2',
      threadId: 'thread-2',
    })
  })

  it('preserves an explicit new-thread workspace selection when requested', () => {
    const snapshot = {
      daemon: { version: '0.1.0', started_at: '2026-03-15T10:00:00Z' },
      workspaces: [workspace({ current_thread_id: 'thread-1' })],
      threads: [thread()],
      interactive_requests: [],
      preferences: normalizePreferences(null),
    }

    expect(
      reconcileSnapshotSelection(snapshot, 'workspace-1', null, {
        preserveEmptyThreadSelection: true,
      }),
    ).toEqual({
      workspaceId: 'workspace-1',
      threadId: null,
    })
  })
})
