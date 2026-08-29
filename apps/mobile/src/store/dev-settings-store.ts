/**
 * Device-local developer/diagnostics preferences. Persisted in MMKV so the
 * perf overlay survives relaunches; never synced to the desktop.
 */
import { create } from 'zustand'

import { getJson, setJson } from '@/storage/mmkv'

const DEV_SETTINGS_KEY = 'mobile.dev-settings'

type PersistedDevSettings = {
  showPerfOverlay: boolean
}

type DevSettingsState = PersistedDevSettings & {
  setShowPerfOverlay: (value: boolean) => void
}

const stored = getJson<PersistedDevSettings>(DEV_SETTINGS_KEY)

export const useDevSettingsStore = create<DevSettingsState>((set, get) => ({
  showPerfOverlay: stored?.showPerfOverlay ?? false,
  setShowPerfOverlay: (value) => {
    set({ showPerfOverlay: value })
    setJson(DEV_SETTINGS_KEY, { showPerfOverlay: get().showPerfOverlay })
  },
}))
