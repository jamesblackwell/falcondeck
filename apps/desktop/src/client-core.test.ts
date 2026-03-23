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
  deriveIdentityKeyPair,
  encryptJson,
  generateBoxKeyPair,
  identityPublicKeyToBase64,
  normalizePreferences,
  projectLabel,
  publicKeyToBase64,
  reconcileSnapshotSelection,
  REMOTE_SESSION_STORAGE_VERSION,
  selectedSkillsFromText,
  activeSlashQuery,
  shouldReusePersistedRemoteSession,
  upsertConversationItem,
  type ConversationItem,
  type EventEnvelope,
  type PersistedRemoteSession,
  type SessionKeyMaterial,
  type ThreadDetail,
  type ThreadSummary,
  type WorkspaceSummary,
} from '@falcondeck/client-core'

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

describe('client-core skills helpers', () => {
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

  it('appends newer items without scanning the full array', () => {
    const spy = vi.spyOn(Array.prototype, 'findIndex')
    const items = [assistantMessage('a', '2026-03-15T10:00:00Z', 'first')]

    const updated = upsertConversationItem(
      items,
      assistantMessage('b', '2026-03-15T10:01:00Z', 'second'),
    )

    expect(updated.map((item) => item.id)).toEqual(['a', 'b'])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
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
    }
    expect(applyEventToThreadDetail(detail, event)?.workspace.updated_at).toBe(
      '2026-03-15T10:10:00Z',
    )
  })

  it('returns no conversation items for a new thread composer', () => {
    const detail: ThreadDetail = {
      workspace: workspace(),
      thread: thread(),
      items: [assistantMessage('a', '2026-03-15T10:00:00Z', 'hello')],
    }

    expect(conversationItemsForSelection('workspace-1', null, detail)).toEqual([])
  })

  it('ignores stale thread detail from another thread and uses fallback items', () => {
    const detail: ThreadDetail = {
      workspace: workspace(),
      thread: thread(),
      items: [assistantMessage('a', '2026-03-15T10:00:00Z', 'stale')],
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

    const sessionCrypto = bootstrapSessionCrypto(clientKeyPair, material)
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

    expect(() => bootstrapSessionCrypto(clientKeyPair, material)).toThrow(
      'Encrypted session bootstrap is not addressed to this client',
    )
  })
})

describe('client-core remote session persistence', () => {
  it('ignores a saved session when a fresh QR pairing code is opened', () => {
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

    expect(shouldReusePersistedRemoteSession(params, persisted)).toBeNull()
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

  it('ignores a saved custom-relay session when a default-relay pairing link omits relay=', () => {
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

    expect(shouldReusePersistedRemoteSession(params, persisted)).toBeNull()
  })

  it('ignores a saved session from an older persistence version', () => {
    const persisted = {
      version: 1,
      relayUrl: 'https://connect.falcondeck.com',
      pairingCode: 'PAIRCODE1234',
      sessionId: 'session-1',
      clientToken: 'client-1',
      clientSecretKey: 'secret',
    } as any

    expect(shouldReusePersistedRemoteSession(new URLSearchParams(), persisted)).toBeNull()
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
