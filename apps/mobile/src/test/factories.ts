/**
 * Test factory functions for creating typed test data.
 * Mirrors the pattern from apps/desktop/src/client-core.test.ts.
 */
import type {
  FalconDeckPreferences,
  WorkspaceSummary,
  ThreadSummary,
  ConversationItem,
  ApprovalRequest,
  DaemonSnapshot,
  EventEnvelope,
  ThreadDetail,
} from '@falcondeck/client-core'

export function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
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
    connected_at: '2026-03-16T10:00:00Z',
    updated_at: '2026-03-16T10:00:00Z',
    last_error: null,
    ...overrides,
  }
}

export function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: 'thread-1',
    workspace_id: 'workspace-1',
    title: 'Test thread',
    provider: 'codex',
    status: 'idle',
    updated_at: '2026-03-16T10:00:00Z',
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

export function snapshot(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    daemon: { version: '0.1.0', started_at: '2026-03-16T09:00:00Z' },
    workspaces: [workspace()],
    threads: [thread()],
    interactive_requests: [],
    preferences: preferences(),
    ...overrides,
  }
}

export function preferences(overrides: Partial<FalconDeckPreferences> = {}): FalconDeckPreferences {
  return {
    version: 1,
    conversation: {
      tool_details_mode: 'auto',
      auto_expand: {
        approvals: true,
        errors: true,
        first_diff: true,
        failed_tests: true,
      },
      group_read_only_tools: true,
      show_expand_all_controls: true,
    },
    ...overrides,
  }
}

export function userMessage(id: string, text: string, created_at = '2026-03-16T10:00:00Z'): ConversationItem {
  return { kind: 'user_message', id, text, attachments: [], created_at }
}

export function assistantMessage(id: string, text: string, created_at = '2026-03-16T10:01:00Z'): ConversationItem {
  return { kind: 'assistant_message', id, text, created_at }
}

export function toolCall(id: string, title: string, status = 'completed', created_at = '2026-03-16T10:02:00Z'): ConversationItem {
  return {
    kind: 'tool_call',
    id,
    title,
    tool_kind: 'bash',
    status,
    output: null,
    exit_code: null,
    display: {
      is_read_only: false,
      has_side_effect: true,
      is_error: false,
      artifact_kind: 'none',
      summary_hint: null,
    },
    created_at,
    completed_at: null,
  }
}

export function serviceMessage(id: string, message: string, level: 'info' | 'warning' | 'error' = 'info'): ConversationItem {
  return { kind: 'service', id, level, message, created_at: '2026-03-16T10:03:00Z' }
}

export function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    request_id: 'approval-1',
    workspace_id: 'workspace-1',
    thread_id: 'thread-1',
    method: 'bash',
    kind: 'approval',
    title: 'Run command',
    detail: 'rm -rf node_modules',
    command: 'rm -rf node_modules',
    path: '/Users/james/falcondeck',
    turn_id: null,
    item_id: null,
    questions: [],
    created_at: '2026-03-16T10:04:00Z',
    ...overrides,
  }
}

export function threadDetail(overrides: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    workspace: workspace(),
    thread: thread(),
    items: [],
    ...overrides,
  }
}

export function snapshotEvent(snap: DaemonSnapshot): EventEnvelope {
  return {
    seq: 1,
    emitted_at: '2026-03-16T10:00:00Z',
    workspace_id: null,
    thread_id: null,
    event: { type: 'snapshot', snapshot: snap },
  }
}

export function conversationItemAddedEvent(item: ConversationItem, threadId = 'thread-1'): EventEnvelope {
  return {
    seq: 2,
    emitted_at: '2026-03-16T10:01:00Z',
    workspace_id: 'workspace-1',
    thread_id: threadId,
    event: { type: 'conversation-item-added', item },
  }
}

export function threadUpdatedEvent(t: ThreadSummary): EventEnvelope {
  return {
    seq: 3,
    emitted_at: '2026-03-16T10:02:00Z',
    workspace_id: t.workspace_id,
    thread_id: t.id,
    event: { type: 'thread-updated', thread: t },
  }
}
