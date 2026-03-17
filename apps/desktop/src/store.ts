import type { DaemonSnapshot, EventEnvelope, ThreadSummary, TimelineEntry } from './types'

export type ConnectionStatus = 'connecting' | 'ready' | 'error'

export type UiState = {
  snapshot: DaemonSnapshot | null
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  connectionStatus: ConnectionStatus
  connectionError: string | null
  eventsByThread: Record<string, EventEnvelope[]>
}

export const DEFAULT_UI_STATE: UiState = {
  snapshot: null,
  selectedWorkspaceId: null,
  selectedThreadId: null,
  connectionStatus: 'connecting',
  connectionError: null,
  eventsByThread: {},
}

type UiAction =
  | { type: 'snapshot-loaded'; snapshot: DaemonSnapshot }
  | { type: 'event-received'; event: EventEnvelope }
  | { type: 'workspace-connected'; workspaceId: string }
  | { type: 'thread-selected'; workspaceId: string; threadId: string }
  | { type: 'connection-state'; status: ConnectionStatus; error?: string }

function upsertThread(threads: ThreadSummary[], nextThread: ThreadSummary) {
  const existing = threads.findIndex((thread) => thread.id === nextThread.id)
  if (existing === -1) {
    return [nextThread, ...threads]
  }

  return threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
}

function formatSystemEvent(event: EventEnvelope['event']) {
  switch (event.type) {
    case 'turn-start':
      return 'Turn started'
    case 'turn-end':
      return event.error ? `Turn failed: ${event.error}` : `Turn ${event.status}`
    case 'start':
      return event.title ? `Session started: ${event.title}` : 'Session started'
    case 'stop':
      return event.reason ? `Session stopped: ${event.reason}` : 'Session stopped'
    case 'file':
      return event.summary
    default:
      return ''
  }
}

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'snapshot-loaded': {
      const selectedThreadId =
        state.selectedThreadId ??
        action.snapshot.workspaces.find((workspace) => workspace.current_thread_id)?.current_thread_id ??
        action.snapshot.threads[0]?.id ??
        null
      const selectedWorkspaceId =
        state.selectedWorkspaceId ??
        action.snapshot.workspaces.find((workspace) => workspace.current_thread_id === selectedThreadId)?.id ??
        action.snapshot.workspaces[0]?.id ??
        null
      return {
        ...state,
        snapshot: action.snapshot,
        selectedThreadId,
        selectedWorkspaceId,
      }
    }
    case 'workspace-connected':
      return {
        ...state,
        selectedWorkspaceId: action.workspaceId,
        selectedThreadId:
          state.snapshot?.workspaces.find((workspace) => workspace.id === action.workspaceId)?.current_thread_id ??
          state.selectedThreadId,
      }
    case 'thread-selected':
      return {
        ...state,
        selectedWorkspaceId: action.workspaceId,
        selectedThreadId: action.threadId,
      }
    case 'connection-state':
      return {
        ...state,
        connectionStatus: action.status,
        connectionError: action.error ?? null,
      }
    case 'event-received': {
      if (action.event.event.type === 'snapshot') {
        return uiReducer(state, { type: 'snapshot-loaded', snapshot: action.event.event.snapshot })
      }

      const nextEventsByThread =
        action.event.thread_id == null
          ? state.eventsByThread
          : {
              ...state.eventsByThread,
              [action.event.thread_id]: [
                ...(state.eventsByThread[action.event.thread_id] ?? []),
                action.event,
              ],
            }

      if (!state.snapshot) {
        return { ...state, eventsByThread: nextEventsByThread }
      }

      let snapshot = state.snapshot
      if (action.event.event.type === 'thread-started') {
        snapshot = {
          ...snapshot,
          threads: upsertThread(snapshot.threads, action.event.event.thread),
        }
      }
      if (action.event.event.type === 'thread-updated') {
        snapshot = {
          ...snapshot,
          threads: upsertThread(snapshot.threads, action.event.event.thread),
        }
      }
      if (action.event.event.type === 'interactive-request') {
        snapshot = {
          ...snapshot,
          interactive_requests: [
            action.event.event.request,
            ...snapshot.interactive_requests.filter(
              (request) => request.request_id !== action.event.event.request.request_id,
            ),
          ],
        }
      }

      return {
        ...state,
        snapshot,
        eventsByThread: nextEventsByThread,
        selectedThreadId: state.selectedThreadId ?? action.event.thread_id,
        selectedWorkspaceId: state.selectedWorkspaceId ?? action.event.workspace_id,
      }
    }
    default:
      return state
  }
}

export function buildTimeline(events: EventEnvelope[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []

  for (const event of events) {
    switch (event.event.type) {
      case 'text': {
        const previous = entries.at(-1)
        if (previous?.kind === 'text' && previous.id === event.event.item_id) {
          previous.markdown = `${previous.markdown ?? ''}${event.event.delta}`
        } else {
          entries.push({
            id: event.event.item_id,
            at: event.emitted_at,
            kind: 'text',
            label: 'Assistant',
            markdown: event.event.delta,
          })
        }
        break
      }
      case 'service':
        entries.push({
          id: `service-${event.seq}`,
          at: event.emitted_at,
          kind: 'service',
          label: event.event.level,
          text: event.event.message,
        })
        break
      case 'tool-call-start':
        entries.push({
          id: `tool-start-${event.seq}`,
          at: event.emitted_at,
          kind: 'tool',
          label: `${event.event.kind} started`,
          text: event.event.title,
        })
        break
      case 'tool-call-end':
        entries.push({
          id: `tool-end-${event.seq}`,
          at: event.emitted_at,
          kind: 'tool',
          label: `${event.event.kind} ${event.event.status}`,
          text: event.event.title,
        })
        break
      case 'interactive-request':
        entries.push({
          id: `interactive-request-${event.event.request.request_id}`,
          at: event.emitted_at,
          kind: 'service',
          label: 'Input needed',
          text: event.event.request.title,
        })
        break
      case 'turn-start':
      case 'turn-end':
      case 'file':
      case 'start':
      case 'stop':
        entries.push({
          id: `system-${event.seq}`,
          at: event.emitted_at,
          kind: 'service',
          label: event.event.type,
          text: formatSystemEvent(event.event),
        })
        break
      case 'thread-started':
      case 'thread-updated':
        break
    }
  }

  return entries
}
