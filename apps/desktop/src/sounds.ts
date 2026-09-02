import { useSyncExternalStore } from 'react'

import type { ThreadStatus } from '@falcondeck/client-core'

import { isTauriDesktop } from './api'

const STORAGE_KEY = 'falcondeck.desktop.sounds.v1'

export type SoundId =
  | 'glass'
  | 'ping'
  | 'pop'
  | 'tink'
  | 'submarine'
  | 'bottle'
  | 'purr'
  | 'chime'
  | 'drop'

export type SoundDefinition = {
  id: SoundId
  label: string
  description: string
  kind: 'system' | 'bundled'
  systemName?: string
  bundledFile?: string
}

export type SoundSettings = {
  enabled: boolean
  soundId: SoundId
}

export const SOUND_CATALOG: readonly SoundDefinition[] = [
  {
    id: 'glass',
    label: 'Glass',
    description: 'Bright macOS glass',
    kind: 'system',
    systemName: 'Glass',
    bundledFile: 'chime.wav',
  },
  {
    id: 'ping',
    label: 'Ping',
    description: 'Classic macOS ping',
    kind: 'system',
    systemName: 'Ping',
    bundledFile: 'chime.wav',
  },
  {
    id: 'pop',
    label: 'Pop',
    description: 'Soft macOS pop',
    kind: 'system',
    systemName: 'Pop',
    bundledFile: 'drop.wav',
  },
  {
    id: 'tink',
    label: 'Tink',
    description: 'Short macOS tick',
    kind: 'system',
    systemName: 'Tink',
    bundledFile: 'drop.wav',
  },
  {
    id: 'submarine',
    label: 'Submarine',
    description: 'Low macOS pulse',
    kind: 'system',
    systemName: 'Submarine',
    bundledFile: 'drop.wav',
  },
  {
    id: 'bottle',
    label: 'Bottle',
    description: 'Hollow macOS bottle',
    kind: 'system',
    systemName: 'Bottle',
    bundledFile: 'chime.wav',
  },
  {
    id: 'purr',
    label: 'Purr',
    description: 'Quiet macOS purr',
    kind: 'system',
    systemName: 'Purr',
    bundledFile: 'drop.wav',
  },
  {
    id: 'chime',
    label: 'Chime',
    description: 'Two-note bell',
    kind: 'bundled',
    bundledFile: 'chime.wav',
  },
  {
    id: 'drop',
    label: 'Drop',
    description: 'Descending tone',
    kind: 'bundled',
    bundledFile: 'drop.wav',
  },
]

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: false,
  soundId: 'glass',
}

const SOUND_IDS = new Set<SoundId>(SOUND_CATALOG.map((sound) => sound.id))
const listeners = new Set<() => void>()

function isSoundId(value: unknown): value is SoundId {
  return typeof value === 'string' && SOUND_IDS.has(value as SoundId)
}

export function isMacDesktop() {
  if (typeof navigator === 'undefined') return false
  return /mac/i.test(navigator.platform) || /Mac OS X|Macintosh/.test(navigator.userAgent)
}

export function canPlaySystemSounds() {
  return isTauriDesktop() && isMacDesktop()
}

export function availableSounds(
  options: { systemSounds?: boolean } = {},
): SoundDefinition[] {
  const includeSystem = options.systemSounds ?? canPlaySystemSounds()
  return SOUND_CATALOG.filter((sound) => sound.kind === 'bundled' || includeSystem)
}

export function resolveSoundId(
  id: string | null | undefined,
  catalog = availableSounds(),
): SoundId {
  if (id && catalog.some((sound) => sound.id === id)) return id as SoundId
  return catalog.find((sound) => sound.kind === 'bundled')?.id ?? 'chime'
}

function definitionFor(id: string): SoundDefinition {
  const catalog = availableSounds()
  const resolved = resolveSoundId(id, catalog)
  return (
    catalog.find((sound) => sound.id === resolved) ??
    SOUND_CATALOG.find((sound) => sound.id === 'chime') ??
    SOUND_CATALOG[0]!
  )
}

export function normalizeSoundSettings(raw: unknown): SoundSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SOUND_SETTINGS }
  const candidate = raw as Partial<SoundSettings>
  return {
    enabled: candidate.enabled === true,
    soundId: isSoundId(candidate.soundId)
      ? candidate.soundId
      : DEFAULT_SOUND_SETTINGS.soundId,
  }
}

function loadSettings(): SoundSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SOUND_SETTINGS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SOUND_SETTINGS }
    return normalizeSoundSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SOUND_SETTINGS }
  }
}

let current = loadSettings()

function notify() {
  for (const listener of listeners) listener()
}

function save() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Device-local persistence is best effort; current remains live in memory.
  }
  notify()
}

export function getSoundSettings() {
  return current
}

export function updateSoundSettings(patch: { enabled?: boolean; soundId?: string }) {
  current = {
    enabled: patch.enabled ?? current.enabled,
    soundId: isSoundId(patch.soundId) ? patch.soundId : current.soundId,
  }
  save()
}

export function subscribeSoundSettings(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSoundSettings() {
  return useSyncExternalStore(subscribeSoundSettings, getSoundSettings, getSoundSettings)
}

export function resetSoundSettingsForTests() {
  current = { ...DEFAULT_SOUND_SETTINGS }
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Tests still reset the in-memory value.
  }
  notify()
}

export function shouldPlayTurnCompleteSound(
  previous: ThreadStatus | undefined,
  next: ThreadStatus,
) {
  return previous === 'running' && (next === 'idle' || next === 'error')
}

export function nextThreadStatusMap(
  previous: ReadonlyMap<string, ThreadStatus> | null,
  threads: readonly { id: string; status: ThreadStatus }[],
): { completed: boolean; statuses: Map<string, ThreadStatus> } {
  const statuses = new Map(threads.map((thread) => [thread.id, thread.status]))
  if (!previous) return { completed: false, statuses }
  const completed = threads.some((thread) =>
    shouldPlayTurnCompleteSound(previous.get(thread.id), thread.status),
  )
  return { completed, statuses }
}

let activeAudio: HTMLAudioElement | null = null

function bundledUrl(file: string) {
  return `/sounds/${file}`
}

function playSynthesizedFallback() {
  const Context = window.AudioContext
  if (!Context) return
  const context = new Context()
  const now = context.currentTime
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(1318.5, now)
  oscillator.frequency.setValueAtTime(987.8, now + 0.07)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(now)
  oscillator.stop(now + 0.42)
  oscillator.onended = () => {
    void context.close()
  }
}

async function playBundledFile(file: string) {
  const audio = new Audio(bundledUrl(file))
  audio.volume = 0.7
  activeAudio?.pause()
  activeAudio = audio
  try {
    await audio.play()
  } catch {
    playSynthesizedFallback()
  }
}

export async function playSound(id: string = getSoundSettings().soundId) {
  const sound =
    SOUND_CATALOG.find((item) => item.id === id) ?? definitionFor(id)
  if (sound.kind === 'system' && sound.systemName && isTauriDesktop()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('play_system_sound', { name: sound.systemName })
      return
    } catch (error) {
      console.warn('FalconDeck could not play a macOS system sound', error)
    }
  }
  if (sound.bundledFile) {
    await playBundledFile(sound.bundledFile)
    return
  }
  playSynthesizedFallback()
}

export async function playTurnCompleteSound() {
  const settings = getSoundSettings()
  if (!settings.enabled) return
  await playSound(settings.soundId)
}
