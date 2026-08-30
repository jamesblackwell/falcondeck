import type { AgentControlSettings, Automation, AutomationRun } from '@falcondeck/client-core'

import { getJson, removeKey, setJson } from './mmkv'

const AUTOMATION_CACHE_KEY = 'mobile.automations-cache'
const AUTOMATION_CACHE_VERSION = 1

export type AutomationCache = {
  version: typeof AUTOMATION_CACHE_VERSION
  sessionId: string
  automations: Automation[]
  settings: AgentControlSettings | null
  runsByAutomation: Record<string, AutomationRun[]>
  savedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCachedAutomation(value: unknown): value is Automation {
  if (!isRecord(value) || !isRecord(value.trigger) || !isRecord(value.target)) {
    return false
  }
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.state === 'string' &&
    typeof value.trigger.kind === 'string' &&
    typeof value.target.provider === 'string' &&
    typeof value.target.workspace_path === 'string' &&
    Array.isArray(value.required_connectors)
  )
}

function isCachedRun(value: unknown): value is AutomationRun {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.automation_id === 'string' &&
    typeof value.status === 'string'
  )
}

export function loadAutomationCache(sessionId: string): AutomationCache | null {
  const cached = getJson<unknown>(AUTOMATION_CACHE_KEY)
  if (
    !isRecord(cached) ||
    cached.version !== AUTOMATION_CACHE_VERSION ||
    cached.sessionId !== sessionId ||
    !Array.isArray(cached.automations) ||
    !cached.automations.every(isCachedAutomation) ||
    !isRecord(cached.runsByAutomation) ||
    !Object.values(cached.runsByAutomation).every(
      (runs) => Array.isArray(runs) && runs.every(isCachedRun),
    ) ||
    (cached.settings !== null && !isRecord(cached.settings)) ||
    typeof cached.savedAt !== 'string'
  ) {
    return null
  }
  return cached as AutomationCache
}

export function persistAutomationCache(cache: Omit<AutomationCache, 'version'>) {
  setJson(AUTOMATION_CACHE_KEY, { ...cache, version: AUTOMATION_CACHE_VERSION })
}

export function clearAutomationCache() {
  removeKey(AUTOMATION_CACHE_KEY)
}
