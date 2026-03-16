import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'

import {
  applyEventToThreadDetail,
  bootstrapSessionCrypto,
  buildProjectGroups,
  decryptJson,
  encryptJson,
  generateBoxKeyPair,
  projectLabel,
  publicKeyToBase64,
  reconcileSnapshotSelection,
  shouldReusePersistedRemoteSession,
  upsertConversationItem,
  type ConversationItem,
  type EventEnvelope,
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
    status: 'idle',
    updated_at: '2026-03-15T10:00:00Z',
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    codex: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
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
})

describe('client-core relay crypto helpers', () => {
  it('encrypts and decrypts JSON payloads with the shared session key', async () => {
    const dataKey = crypto.getRandomValues(new Uint8Array(32))
    const envelope = await encryptJson(dataKey, { hello: 'world' })
    await expect(decryptJson<{ hello: string }>(dataKey, envelope)).resolves.toEqual({ hello: 'world' })
  })

  it('unwraps bootstrap material into usable session crypto state', async () => {
    const daemonKeyPair = generateBoxKeyPair()
    const clientKeyPair = generateBoxKeyPair()
    const dataKey = crypto.getRandomValues(new Uint8Array(32))
    const nonce = crypto.getRandomValues(new Uint8Array(24))
    const ciphertext = (await import('tweetnacl')).default.box(
      dataKey,
      nonce,
      clientKeyPair.publicKey,
      daemonKeyPair.secretKey,
    )

    const material: SessionKeyMaterial = {
      encryption_variant: 'data_key_v1',
      daemon_public_key: publicKeyToBase64(daemonKeyPair),
      client_public_key: publicKeyToBase64(clientKeyPair),
      client_wrapped_data_key: {
        encryption_variant: 'data_key_v1',
        wrapped_key: btoa(
          String.fromCharCode(0, ...daemonKeyPair.publicKey, ...nonce, ...ciphertext),
        ),
      },
      daemon_wrapped_data_key: null,
    }

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
      daemon_public_key: publicKeyToBase64(daemonKeyPair),
      client_public_key: publicKeyToBase64(otherClientKeyPair),
      client_wrapped_data_key: {
        encryption_variant: 'data_key_v1',
        wrapped_key: btoa(
          String.fromCharCode(0, ...daemonKeyPair.publicKey, ...nonce, ...ciphertext),
        ),
      },
      daemon_wrapped_data_key: null,
    }

    expect(() => bootstrapSessionCrypto(clientKeyPair, material)).toThrow(
      'Encrypted session bootstrap is not addressed to this client',
    )
  })
})

describe('client-core remote session persistence', () => {
  it('ignores a saved session when a fresh QR pairing code is opened', () => {
    const persisted = {
      relayUrl: 'https://connect.falcondeck.com',
      pairingCode: 'OLDPAIR123456',
      sessionId: 'session-old',
      clientToken: 'client-old',
      clientSecretKey: 'secret',
    }

    const params = new URLSearchParams({
      relay: 'https://connect.falcondeck.com',
      code: 'NEWPAIR654321',
    })

    expect(shouldReusePersistedRemoteSession(params, persisted)).toBeNull()
  })

  it('reuses a saved session when the URL does not override it', () => {
    const persisted = {
      relayUrl: 'https://connect.falcondeck.com',
      pairingCode: 'PAIRCODE1234',
      sessionId: 'session-1',
      clientToken: 'client-1',
      clientSecretKey: 'secret',
    }

    expect(shouldReusePersistedRemoteSession(new URLSearchParams(), persisted)).toEqual(persisted)
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
      approvals: [],
    }

    expect(
      reconcileSnapshotSelection(snapshot, 'workspace-stale', 'thread-stale'),
    ).toEqual({
      workspaceId: 'workspace-2',
      threadId: 'thread-2',
    })
  })
})
