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

export function loadAutomationCache(sessionId: string): AutomationCache | null {
  const cached = getJson<AutomationCache>(AUTOMATION_CACHE_KEY)
  if (
    !cached ||
    cached.version !== AUTOMATION_CACHE_VERSION ||
    cached.sessionId !== sessionId ||
    !Array.isArray(cached.automations) ||
    typeof cached.runsByAutomation !== 'object'
  ) {
    return null
  }
  return cached
}

export function persistAutomationCache(cache: Omit<AutomationCache, 'version'>) {
  setJson(AUTOMATION_CACHE_KEY, { ...cache, version: AUTOMATION_CACHE_VERSION })
}

export function clearAutomationCache() {
  removeKey(AUTOMATION_CACHE_KEY)
}
