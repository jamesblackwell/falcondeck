import { describe, it, expect } from 'vitest'

import {
  workspace,
  thread,
  snapshot,
  userMessage,
  assistantMessage,
  toolCall,
  serviceMessage,
  approval,
  threadDetail,
  snapshotEvent,
  conversationItemAddedEvent,
  threadUpdatedEvent,
} from './factories'

describe('test factories', () => {
  it('workspace produces valid WorkspaceSummary', () => {
    const ws = workspace()
    expect(ws.id).toBe('workspace-1')
    expect(ws.path).toContain('falcondeck')
    expect(ws.status).toBe('ready')
    expect(ws.models).toEqual([])
  })

  it('workspace accepts overrides', () => {
    const ws = workspace({ id: 'custom', path: '/tmp/test', status: 'connecting' })
    expect(ws.id).toBe('custom')
    expect(ws.path).toBe('/tmp/test')
    expect(ws.status).toBe('connecting')
  })

  it('thread produces valid ThreadSummary', () => {
    const t = thread()
    expect(t.id).toBe('thread-1')
    expect(t.workspace_id).toBe('workspace-1')
    expect(t.status).toBe('idle')
    expect(t.agent).toBeDefined()
  })

  it('snapshot contains workspace and thread arrays', () => {
    const s = snapshot()
    expect(s.daemon.version).toBe('0.1.0')
    expect(s.workspaces).toHaveLength(1)
    expect(s.threads).toHaveLength(1)
    expect(s.interactive_requests).toHaveLength(0)
  })

  it('conversation item factories produce correct kinds', () => {
    expect(userMessage('u1', 'hi').kind).toBe('user_message')
    expect(assistantMessage('a1', 'hello').kind).toBe('assistant_message')
    expect(toolCall('t1', 'bash').kind).toBe('tool_call')
    expect(serviceMessage('s1', 'info').kind).toBe('service')
  })

  it('userMessage includes empty attachments array', () => {
    const msg = userMessage('u1', 'test')
    expect(msg.kind === 'user_message' && msg.attachments).toEqual([])
  })

  it('toolCall defaults to completed status', () => {
    const tc = toolCall('t1', 'Edit file')
    expect(tc.kind === 'tool_call' && tc.status).toBe('completed')
  })

  it('approval has all required fields', () => {
    const a = approval()
    expect(a.request_id).toBe('approval-1')
    expect(a.title).toBeTruthy()
    expect(a.command).toBeTruthy()
    expect(a.workspace_id).toBe('workspace-1')
  })

  it('threadDetail defaults to empty items', () => {
    const td = threadDetail()
    expect(td.items).toEqual([])
    expect(td.workspace.id).toBe('workspace-1')
    expect(td.thread.id).toBe('thread-1')
  })

  it('snapshotEvent wraps a snapshot in an EventEnvelope', () => {
    const s = snapshot()
    const ev = snapshotEvent(s)
    expect(ev.event.type).toBe('snapshot')
    expect(ev.workspace_id).toBeNull()
    expect(ev.thread_id).toBeNull()
  })

  it('conversationItemAddedEvent wraps an item in an EventEnvelope', () => {
    const msg = assistantMessage('a1', 'hello')
    const ev = conversationItemAddedEvent(msg, 'thread-x')
    expect(ev.event.type).toBe('conversation-item-added')
    expect(ev.thread_id).toBe('thread-x')
  })

  it('threadUpdatedEvent wraps a thread in an EventEnvelope', () => {
    const t = thread({ id: 't2', workspace_id: 'w2', status: 'running' })
    const ev = threadUpdatedEvent(t)
    expect(ev.event.type).toBe('thread-updated')
    expect(ev.workspace_id).toBe('w2')
    expect(ev.thread_id).toBe('t2')
  })
})
