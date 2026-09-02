import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invoke } from '@tauri-apps/api/core'

import {
  availableSounds,
  canPlaySystemSounds,
  DEFAULT_SOUND_SETTINGS,
  getSoundSettings,
  nextThreadStatusMap,
  normalizeSoundSettings,
  playSound,
  playTurnCompleteSound,
  resetSoundSettingsForTests,
  resolveSoundId,
  shouldPlayTurnCompleteSound,
  updateSoundSettings,
} from './sounds'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const mockedInvoke = vi.mocked(invoke)

function seedStatuses(
  entries: Array<[string, 'idle' | 'running' | 'waiting_for_input' | 'error']>,
) {
  return new Map(entries)
}

describe('sound settings', () => {
  afterEach(() => {
    resetSoundSettingsForTests()
    delete window.__TAURI_INTERNALS__
    vi.restoreAllMocks()
  })

  it('defaults to off', () => {
    expect(getSoundSettings()).toEqual(DEFAULT_SOUND_SETTINGS)
    expect(getSoundSettings().enabled).toBe(false)
  })

  it('persists the toggle and selected chime', () => {
    updateSoundSettings({ enabled: true, soundId: 'drop' })
    expect(getSoundSettings()).toEqual({ enabled: true, soundId: 'drop' })
    expect(JSON.parse(window.localStorage.getItem('falcondeck.desktop.sounds.v1') ?? '{}')).toEqual(
      { enabled: true, soundId: 'drop' },
    )
  })

  it('ignores unknown stored ids and treats missing enabled as off', () => {
    expect(normalizeSoundSettings({ enabled: 'yes', soundId: 'laser' })).toEqual(
      DEFAULT_SOUND_SETTINGS,
    )
    expect(normalizeSoundSettings({ enabled: true, soundId: 'drop' })).toEqual({
      enabled: true,
      soundId: 'drop',
    })
  })
})

describe('sound catalog', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__
  })

  it('hides macOS system chimes outside the packaged Mac app', () => {
    expect(availableSounds({ systemSounds: false }).map((sound) => sound.id)).toEqual([
      'chime',
      'drop',
    ])
    expect(canPlaySystemSounds()).toBe(false)
  })

  it('offers native macOS chimes when the desktop shell can play them', () => {
    window.__TAURI_INTERNALS__ = {}
    expect(availableSounds({ systemSounds: true }).map((sound) => sound.id)).toEqual([
      'glass',
      'ping',
      'pop',
      'tink',
      'submarine',
      'bottle',
      'purr',
      'chime',
      'drop',
    ])
  })

  it('falls back to a bundled chime when the saved id is unavailable', () => {
    expect(resolveSoundId('glass', availableSounds({ systemSounds: false }))).toBe('chime')
    expect(resolveSoundId('drop', availableSounds({ systemSounds: false }))).toBe('drop')
  })
})

describe('turn-complete detection', () => {
  it('plays when a running turn becomes idle or errors', () => {
    expect(shouldPlayTurnCompleteSound('running', 'idle')).toBe(true)
    expect(shouldPlayTurnCompleteSound('running', 'error')).toBe(true)
  })

  it('does not play for approvals, repeats, or the first snapshot', () => {
    expect(shouldPlayTurnCompleteSound('running', 'waiting_for_input')).toBe(false)
    expect(shouldPlayTurnCompleteSound('idle', 'idle')).toBe(false)
    expect(shouldPlayTurnCompleteSound(undefined, 'idle')).toBe(false)

    const first = nextThreadStatusMap(null, [{ id: 'thread-1', status: 'idle' }])
    expect(first.completed).toBe(false)

    const stillIdle = nextThreadStatusMap(first.statuses, [{ id: 'thread-1', status: 'idle' }])
    expect(stillIdle.completed).toBe(false)
  })

  it('detects a completed turn across a snapshot update', () => {
    const previous = seedStatuses([['thread-1', 'running']])
    const next = nextThreadStatusMap(previous, [{ id: 'thread-1', status: 'idle' }])
    expect(next.completed).toBe(true)
  })

  it('plays a single chime when several turns finish in one snapshot', () => {
    const previous = seedStatuses([
      ['thread-1', 'running'],
      ['thread-2', 'running'],
    ])
    const next = nextThreadStatusMap(previous, [
      { id: 'thread-1', status: 'idle' },
      { id: 'thread-2', status: 'error' },
    ])
    expect(next.completed).toBe(true)
  })
})

describe('playback', () => {
  beforeEach(() => {
    resetSoundSettingsForTests()
    mockedInvoke.mockReset()
    delete window.__TAURI_INTERNALS__
  })

  afterEach(() => {
    resetSoundSettingsForTests()
    delete window.__TAURI_INTERNALS__
    vi.restoreAllMocks()
  })

  it('does not play when the setting is off', async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(window, 'Audio').mockImplementation(
      () => ({ volume: 1, pause: vi.fn(), play }) as unknown as HTMLAudioElement,
    )

    await playTurnCompleteSound()

    expect(play).not.toHaveBeenCalled()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('plays a macOS system sound from the desktop shell', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockedInvoke.mockResolvedValue(undefined)

    await playSound('glass')

    expect(mockedInvoke).toHaveBeenCalledWith('play_system_sound', { name: 'Glass' })
  })

  it('falls back to the bundled file when the native command fails', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockedInvoke.mockRejectedValue(new Error('no sound'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const play = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(window, 'Audio').mockImplementation(
      () => ({ volume: 1, pause: vi.fn(), play }) as unknown as HTMLAudioElement,
    )

    await playSound('glass')

    expect(play).toHaveBeenCalledOnce()
  })
})
