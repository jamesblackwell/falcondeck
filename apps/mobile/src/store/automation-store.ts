import { create } from 'zustand'

import {
  normalizeAgentControlSettings,
  normalizeAutomation,
  normalizeAutomationRun,
  normalizeControlErrorDetail,
  type AgentControlSettings,
  type Automation,
  type AutomationRun,
  type ControlErrorDetail,
  type ControlExecuteRequest,
  type ControlExecuteResponse,
  type ControlGetResponse,
} from '@falcondeck/client-core'

import { loadAutomationCache, persistAutomationCache } from '@/storage/automation-cache'

import { useRelayStore } from './relay-store'

type AutomationState = {
  sessionId: string | null
  automations: Automation[]
  settings: AgentControlSettings | null
  runsByAutomation: Record<string, AutomationRun[]>
  hydrated: boolean
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
  lastSyncedAt: string | null
}

type AutomationActions = {
  hydrate: (sessionId: string) => void
  refresh: (options?: { silent?: boolean }) => Promise<void>
  read: (automationId: string) => Promise<Automation | null>
  loadRuns: (automationId: string) => Promise<AutomationRun[]>
  execute: (request: ControlExecuteRequest) => Promise<unknown>
  clearError: () => void
  reset: () => void
}

type AutomationStore = AutomationState & AutomationActions

const initialState: AutomationState = {
  sessionId: null,
  automations: [],
  settings: null,
  runsByAutomation: {},
  hydrated: false,
  isLoading: false,
  isRefreshing: false,
  error: null,
  lastSyncedAt: null,
}

export class AutomationControlError extends Error {
  readonly detail: ControlErrorDetail | null

  constructor(message: string, detail: ControlErrorDetail | null = null) {
    super(message)
    this.name = 'AutomationControlError'
    this.detail = detail
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function readRows<T>(response: ControlGetResponse, normalize: (value: unknown) => T | null) {
  return Array.isArray(response.data)
    ? response.data.map(normalize).filter((value): value is T => value !== null)
    : []
}

function persist(state: AutomationState) {
  if (!state.sessionId) return
  persistAutomationCache({
    sessionId: state.sessionId,
    automations: state.automations,
    settings: state.settings,
    runsByAutomation: state.runsByAutomation,
    savedAt: state.lastSyncedAt ?? new Date().toISOString(),
  })
}

let refreshInFlight: Promise<void> | null = null

export const useAutomationStore = create<AutomationStore>((set, get) => ({
  ...initialState,

  hydrate: (sessionId) => {
    if (get().hydrated && get().sessionId === sessionId) return
    const cached = loadAutomationCache(sessionId)
    set({
      ...initialState,
      sessionId,
      hydrated: true,
      automations: cached?.automations.map(normalizeAutomation).filter((row): row is Automation => !!row) ?? [],
      settings: cached?.settings ? normalizeAgentControlSettings(cached.settings) : null,
      runsByAutomation: cached?.runsByAutomation ?? {},
      lastSyncedAt: cached?.savedAt ?? null,
    })
  },

  refresh: async (options) => {
    if (refreshInFlight) return refreshInFlight
    const run = async () => {
      const hasCachedRows = get().automations.length > 0
      set({
        isLoading: !options?.silent && !hasCachedRows,
        isRefreshing: true,
        error: options?.silent ? get().error : null,
      })
      try {
        const relay = useRelayStore.getState()
        const [automationResponse, settingsResponse] = await Promise.all([
          relay._callRpc<ControlGetResponse>('control.get', {
            resource: 'automations',
            limit: 100,
          }, { requestIdPrefix: 'mobile-automations' }),
          relay._callRpc<ControlGetResponse>('control.get', {
            resource: 'agent_control.settings',
          }, { requestIdPrefix: 'mobile-control-settings' }).catch(() => null),
        ])
        const automations = readRows(automationResponse, normalizeAutomation)
        const settings = settingsResponse
          ? normalizeAgentControlSettings(settingsResponse.data)
          : get().settings
        const existingIds = new Set(automations.map((automation) => automation.id))
        const runsByAutomation = Object.fromEntries(
          Object.entries(get().runsByAutomation).filter(([id]) => existingIds.has(id)),
        )
        const lastSyncedAt = new Date().toISOString()
        set({ automations, settings, runsByAutomation, lastSyncedAt, error: null })
        persist(get())
      } catch (error) {
        set({ error: errorMessage(error) })
        throw error
      } finally {
        set({ isLoading: false, isRefreshing: false })
      }
    }
    refreshInFlight = run().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  },

  read: async (automationId) => {
    const response = await useRelayStore.getState()._callRpc<ControlGetResponse>(
      'control.get',
      { resource: 'automation', id: automationId },
      { requestIdPrefix: 'mobile-automation-detail' },
    )
    const automation = normalizeAutomation(response.data)
    if (automation) {
      set((state) => ({
        automations: state.automations.some((row) => row.id === automation.id)
          ? state.automations.map((row) => row.id === automation.id ? automation : row)
          : [automation, ...state.automations],
      }))
      persist(get())
    }
    return automation
  },

  loadRuns: async (automationId) => {
    try {
      const response = await useRelayStore.getState()._callRpc<ControlGetResponse>(
        'control.get',
        { resource: 'automation.runs', id: automationId, limit: 50 },
        { requestIdPrefix: 'mobile-automation-runs' },
      )
      const runs = readRows(response, normalizeAutomationRun)
      set((state) => ({
        runsByAutomation: { ...state.runsByAutomation, [automationId]: runs },
      }))
      persist(get())
      return runs
    } catch (error) {
      if (get().runsByAutomation[automationId]) return get().runsByAutomation[automationId]!
      throw error
    }
  },

  execute: async (request) => {
    const rpcRequest: ControlExecuteRequest = {
      ...request,
      // The relay deduplicates by RPC request id. The daemon key also covers
      // a retry that is rebuilt after a reconnect before its response lands.
      idempotency_key: request.idempotency_key ?? globalThis.crypto?.randomUUID?.()
        ?? `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }
    const response = await useRelayStore.getState()._callRpc<ControlExecuteResponse>(
      'control.execute',
      rpcRequest as unknown as Record<string, unknown>,
      { requestIdPrefix: 'mobile-control-execute' },
    )
    if (!response.ok) {
      const detail = normalizeControlErrorDetail(response.error)
      throw new AutomationControlError(
        detail?.suggested_action ?? detail?.message ?? 'FalconDeck returned no control result.',
        detail,
      )
    }
    const returnedAutomation = normalizeAutomation(response.data)
    const returnedRun = normalizeAutomationRun(response.data)
    set((state) => ({
      automations: request.operation === 'automation.delete'
        ? state.automations.filter((automation) =>
            automation.id !== String(request.arguments.automation_id ?? ''),
          )
        : returnedAutomation
          ? state.automations.some((automation) => automation.id === returnedAutomation.id)
            ? state.automations.map((automation) =>
                automation.id === returnedAutomation.id ? returnedAutomation : automation,
              )
            : [returnedAutomation, ...state.automations]
          : state.automations,
      runsByAutomation: returnedRun
        ? {
            ...state.runsByAutomation,
            [returnedRun.automation_id]: [
              returnedRun,
              ...(state.runsByAutomation[returnedRun.automation_id] ?? [])
                .filter((run) => run.id !== returnedRun.id),
            ].slice(0, 50),
          }
        : state.runsByAutomation,
    }))
    persist(get())
    // The mutation is already confirmed at this point. A follow-up read may
    // fail if connectivity drops, but that must not tell the user the action
    // failed. The response above updates the cache immediately and the
    // control-state event supplies another convergence opportunity.
    void get().refresh({ silent: true }).catch(() => {})
    return response.data
  },

  clearError: () => set({ error: null }),
  reset: () => set(initialState),
}))
