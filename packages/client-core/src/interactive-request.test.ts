import { describe, expect, it } from 'vitest'

import {
  interactiveApprovalDecisions,
  interactiveRequestEvidencePresentation,
  interactiveRequestReceiptPresentation,
  interactiveResolutionFromResponse,
  orderedInteractiveRequestQueue,
} from './conversation'
import type { InteractiveRequest } from './types'

function pendingRequest(
  requestId: string,
  createdAt: string,
  title = requestId,
): InteractiveRequest {
  return {
    request_id: requestId,
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    method: 'approval/request',
    kind: 'approval',
    title,
    detail: null,
    command: null,
    path: null,
    turn_id: 'turn-1',
    item_id: null,
    questions: [],
    created_at: createdAt,
  }
}

describe('interactive request queue', () => {
  it('orders oldest first and deduplicates replayed identities with their latest payload', () => {
    const queue = orderedInteractiveRequestQueue([
      pendingRequest('request-new', '2026-08-09T12:00:02Z'),
      pendingRequest('request-old', '2026-08-09T12:00:01Z', 'Original title'),
      pendingRequest('request-old', '2026-08-09T12:00:01Z', 'Updated title'),
    ])

    expect(queue.map((request) => request.request_id)).toEqual([
      'request-old',
      'request-new',
    ])
    expect(queue[0]?.title).toBe('Updated title')
  })

  it('uses stable ids for tied or malformed provider timestamps', () => {
    const queue = orderedInteractiveRequestQueue([
      pendingRequest('request-z', 'not-a-date'),
      pendingRequest('request-b', '2026-08-09T12:00:01Z'),
      pendingRequest('request-a', '2026-08-09T12:00:01Z'),
    ])

    expect(queue.map((request) => request.request_id)).toEqual([
      'request-a',
      'request-b',
      'request-z',
    ])
  })
})

describe('interactive approval capabilities', () => {
  it('uses conservative one-time choices for legacy approvals', () => {
    expect(interactiveApprovalDecisions(pendingRequest(
      'legacy',
      '2026-08-09T12:00:00Z',
    ))).toEqual(['allow', 'deny'])
  })

  it('preserves explicit provider choices including an explicit empty set', () => {
    expect(interactiveApprovalDecisions({
      ...pendingRequest('scoped', '2026-08-09T12:00:00Z'),
      approval_decisions: ['deny'],
    })).toEqual(['deny'])
    expect(interactiveApprovalDecisions({
      ...pendingRequest('unsupported', '2026-08-09T12:00:00Z'),
      approval_decisions: [],
    })).toEqual([])
  })
})

describe('interactive request receipts', () => {
  it.each([
    ['allow', 'allowed', 'Allowed npm test', 'success'],
    ['always_allow', 'always_allowed', 'Always allowed npm test', 'success'],
    ['deny', 'denied', 'Denied npm test', 'danger'],
  ] as const)('maps %s approvals to an accurate receipt', (decision, outcome, label, tone) => {
    const resolution = interactiveResolutionFromResponse(
      { kind: 'approval', decision },
      '2026-08-09T12:00:00Z',
    )

    expect(resolution).toEqual({ outcome, resolved_at: '2026-08-09T12:00:00Z' })
    expect(interactiveRequestReceiptPresentation(
      { kind: 'approval', title: 'Allow npm test?' },
      resolution,
    )).toEqual({ label, tone })
  })

  it('records that a question was answered without retaining answer values', () => {
    const resolution = interactiveResolutionFromResponse(
      { kind: 'question', answers: { password: ['do-not-retain-this'] } },
      '2026-08-09T12:00:00Z',
    )

    expect(resolution).toEqual({ outcome: 'answered', resolved_at: '2026-08-09T12:00:00Z' })
    expect(JSON.stringify(resolution)).not.toContain('do-not-retain-this')
    expect(interactiveRequestReceiptPresentation(
      { kind: 'question', title: 'Choose an environment?' },
      resolution,
    )).toEqual({ label: 'Answered: Choose an environment', tone: 'info' })
  })

  it.each([
    ['expired', 'Expired: Allow npm test', 'warning'],
    ['cancelled', 'Cancelled: Allow npm test', 'warning'],
  ] as const)('presents %s outcomes explicitly', (outcome, label, tone) => {
    expect(interactiveRequestReceiptPresentation(
      { kind: 'approval', title: 'Allow npm test?' },
      { outcome, resolved_at: '2026-08-09T12:00:00Z' },
    )).toEqual({ label, tone })
  })

  it('uses a neutral label for legacy receipts instead of inferring success', () => {
    expect(interactiveRequestReceiptPresentation(
      { kind: 'approval', title: 'Allow npm test?' },
      null,
    )).toEqual({ label: 'Resolved: Allow npm test', tone: 'neutral' })
  })

  it('normalizes complete provider evidence without duplicating promoted fields', () => {
    expect(interactiveRequestEvidencePresentation({
      command: 'npm test -- /workspace',
      path: '/workspace',
      detail: '{"command":"npm test -- /workspace","description":"Runs the release suite."}',
      questions: [],
    })).toEqual({
      summary: 'npm test -- /workspace',
      command: 'npm test -- /workspace',
      path: null,
      detail: 'Runs the release suite.',
      questions: [],
    })
  })

  it('keeps question prompts but cannot retain user answer values', () => {
    const evidence = interactiveRequestEvidencePresentation({
      command: null,
      path: null,
      detail: null,
      questions: [{
        id: 'token',
        header: 'Credential',
        question: 'Enter the temporary signing token.',
        is_other: true,
        is_secret: true,
        options: null,
      }],
    })

    expect(evidence.summary).toBe('Enter the temporary signing token.')
    expect(evidence.questions).toHaveLength(1)
    expect(JSON.stringify(evidence)).not.toContain('do-not-retain-this')
  })

  it('drops valid transport JSON without useful human copy but preserves malformed evidence', () => {
    expect(interactiveRequestEvidencePresentation({
      command: 'npm test', path: null, detail: '{"command":"npm test"}', questions: [],
    }).detail).toBeNull()
    expect(interactiveRequestEvidencePresentation({
      command: null, path: null, detail: '{provider detail', questions: [],
    }).detail).toBe('{provider detail')
  })
})
