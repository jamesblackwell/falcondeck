/**
 * Demo mode data for App Store review.
 * Provides a realistic snapshot and conversation so reviewers
 * can explore the full UI without a live desktop daemon.
 */
import type {
  ConversationItem,
  DaemonSnapshot,
  ThreadAgentParams,
  ThreadAttention,
  ThreadSummary,
  WorkspaceSummary,
  ReasoningEffortOption,
} from '@falcondeck/client-core'

export const DEMO_PAIRING_CODE = 'DEMO-MODE'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const REASONING_EFFORTS: ReasoningEffortOption[] = [
  { reasoning_effort: 'low', description: 'Fast responses' },
  { reasoning_effort: 'medium', description: 'Balanced' },
  { reasoning_effort: 'high', description: 'Thorough reasoning' },
]

const DEMO_AGENT: ThreadAgentParams = {
  model_id: 'claude-sonnet-4-6',
  reasoning_effort: 'medium',
  collaboration_mode_id: null,
  approval_policy: 'on-request',
  service_tier: null,
}

function makeAttention(seq: number): ThreadAttention {
  return {
    level: 'none',
    badge_label: null,
    unread: false,
    pending_approval_count: 0,
    pending_question_count: 0,
    last_agent_activity_seq: seq,
    last_read_seq: seq,
  }
}

const demoWorkspace: WorkspaceSummary = {
  id: 'demo-workspace',
  path: '/Users/demo/my-project',
  status: 'ready',
  agents: [],
  default_provider: 'claude',
  models: [
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', is_default: true, default_reasoning_effort: 'medium', supported_reasoning_efforts: REASONING_EFFORTS },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', is_default: false, default_reasoning_effort: 'medium', supported_reasoning_efforts: REASONING_EFFORTS },
  ],
  collaboration_modes: [],
  account: { status: 'ready', label: 'demo@falcondeck.com' },
  current_thread_id: 'demo-thread-1',
  connected_at: ago(30),
  updated_at: ago(1),
  last_error: null,
}

const demoThreads: ThreadSummary[] = [
  {
    id: 'demo-thread-1',
    workspace_id: 'demo-workspace',
    title: 'Add user authentication',
    provider: 'claude',
    status: 'idle',
    updated_at: ago(2),
    last_message_preview: 'Authentication is now working with JWT tokens.',
    latest_turn_id: 'turn-1',
    latest_plan: null,
    latest_diff: null,
    last_tool: 'Edit',
    last_error: null,
    agent: DEMO_AGENT,
    attention: makeAttention(10),
    is_archived: false,
  },
  {
    id: 'demo-thread-2',
    workspace_id: 'demo-workspace',
    title: 'Fix database migration',
    provider: 'claude',
    status: 'idle',
    updated_at: ago(45),
    last_message_preview: 'Migration applied successfully.',
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: DEMO_AGENT,
    attention: makeAttention(5),
    is_archived: false,
  },
]

export const demoSnapshot: DaemonSnapshot = {
  daemon: { version: '0.1.0', started_at: ago(60) },
  workspaces: [demoWorkspace],
  threads: demoThreads,
  interactive_requests: [],
  preferences: {
    version: 1,
    conversation: {
      tool_details_mode: 'auto',
      auto_expand: { approvals: true, errors: true, first_diff: true, failed_tests: true },
      group_read_only_tools: true,
      show_expand_all_controls: true,
    },
  },
}

const readOnly = { is_read_only: true, has_side_effect: false, is_error: false, artifact_kind: 'none' as const, summary_hint: null }
const sideEffect = (artifact: 'none' | 'command_output' | 'diff' = 'none') =>
  ({ is_read_only: false, has_side_effect: true, is_error: false, artifact_kind: artifact, summary_hint: null })

export const demoConversationItems: ConversationItem[] = [
  { kind: 'user_message', id: 'msg-1', text: 'Add JWT authentication to the Express API. Use bcrypt for password hashing and store refresh tokens in the database.', attachments: [], created_at: ago(10) },
  { kind: 'assistant_message', id: 'msg-2', text: "I'll implement JWT authentication for your Express API. Let me start by examining the current project structure and then add the necessary packages and middleware.", created_at: ago(9) },
  { kind: 'tool_call', id: 'tc-1', title: 'Read src/server.ts', tool_kind: 'read', status: 'completed', output: 'import express from "express"\nconst app = express()\napp.listen(3000)', exit_code: null, display: readOnly, created_at: ago(9), completed_at: ago(9) },
  { kind: 'tool_call', id: 'tc-2', title: 'Read package.json', tool_kind: 'read', status: 'completed', output: '{ "dependencies": { "express": "^4.18.0" } }', exit_code: null, display: readOnly, created_at: ago(9), completed_at: ago(9) },
  { kind: 'tool_call', id: 'tc-3', title: 'bash: npm install jsonwebtoken bcrypt', tool_kind: 'bash', status: 'completed', output: 'added 2 packages in 1.2s', exit_code: 0, display: sideEffect('command_output'), created_at: ago(8), completed_at: ago(8) },
  { kind: 'tool_call', id: 'tc-4', title: 'Edit src/middleware/auth.ts', tool_kind: 'edit', status: 'completed', output: null, exit_code: null, display: sideEffect('diff'), created_at: ago(7), completed_at: ago(7) },
  { kind: 'tool_call', id: 'tc-5', title: 'Edit src/routes/auth.ts', tool_kind: 'edit', status: 'completed', output: null, exit_code: null, display: sideEffect('diff'), created_at: ago(6), completed_at: ago(6) },
  { kind: 'tool_call', id: 'tc-6', title: 'Edit src/server.ts', tool_kind: 'edit', status: 'completed', output: null, exit_code: null, display: sideEffect('diff'), created_at: ago(5), completed_at: ago(5) },
  { kind: 'assistant_message', id: 'msg-3', text: "I've set up JWT authentication with the following:\n\n- **`src/middleware/auth.ts`** — JWT verification middleware that extracts and validates tokens from the Authorization header\n- **`src/routes/auth.ts`** — Login and register endpoints with bcrypt password hashing, JWT access tokens (15min), and refresh tokens stored in the database\n- **`src/server.ts`** — Updated to mount the auth routes and apply the middleware to protected endpoints\n\nThe refresh token rotation is handled automatically — each refresh invalidates the old token and issues a new pair.", created_at: ago(4) },
  { kind: 'user_message', id: 'msg-4', text: 'Can you run the tests to make sure everything works?', attachments: [], created_at: ago(3) },
  { kind: 'tool_call', id: 'tc-7', title: 'bash: npm test', tool_kind: 'bash', status: 'completed', output: 'PASS src/routes/auth.test.ts\n  ✓ registers a new user (45ms)\n  ✓ rejects duplicate email (12ms)\n  ✓ logs in with valid credentials (38ms)\n  ✓ rejects invalid password (8ms)\n  ✓ refreshes access token (22ms)\n\nTest Suites: 1 passed, 1 total\nTests:       5 passed, 5 total', exit_code: 0, display: sideEffect('command_output'), created_at: ago(2), completed_at: ago(2) },
  { kind: 'assistant_message', id: 'msg-5', text: 'All 5 tests pass. Authentication is working correctly with JWT tokens, bcrypt password hashing, and refresh token rotation.', created_at: ago(1) },
]
