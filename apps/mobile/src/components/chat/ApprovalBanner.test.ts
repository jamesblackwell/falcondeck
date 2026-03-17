import { describe, it, expect } from 'vitest'
import type { ApprovalRequest } from '@falcondeck/client-core'
import { approval } from '../../test/factories'

// Test the ApprovalBanner's data contract — verify it accesses the
// correct fields from ApprovalRequest (title, command, detail).

describe('ApprovalBanner data contract', () => {
  it('ApprovalRequest has title field (not tool_name)', () => {
    const a = approval()
    expect(a.title).toBe('Run command')
    expect((a as any).tool_name).toBeUndefined()
  })

  it('ApprovalRequest has command and detail fields', () => {
    const a = approval({ command: 'npm install', detail: 'Install dependencies' })
    expect(a.command).toBe('npm install')
    expect(a.detail).toBe('Install dependencies')
  })

  it('command and detail can be null', () => {
    const a = approval({ command: null, detail: null })
    expect(a.command).toBeNull()
    expect(a.detail).toBeNull()
  })

  it('request_id is used as the key for callbacks', () => {
    const a = approval({ request_id: 'req-abc-123' })
    expect(a.request_id).toBe('req-abc-123')
  })

  it('workspace_id and thread_id provide context', () => {
    const a = approval({ workspace_id: 'w-1', thread_id: 'thread-5' })
    expect(a.workspace_id).toBe('w-1')
    expect(a.thread_id).toBe('thread-5')
  })

  it('method indicates the tool type', () => {
    const a = approval({ method: 'write' })
    expect(a.method).toBe('write')
  })
})
