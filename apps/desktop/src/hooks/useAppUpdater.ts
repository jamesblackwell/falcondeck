import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getVersion } from '@tauri-apps/api/app'

import { isTauriDesktop, restartDesktopApp } from '../api'

const AUTO_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const INITIAL_UPDATE_CHECK_DELAY_MS = 15_000

export type AppUpdaterState = {
  status:
    | 'idle'
    | 'unsupported'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'upToDate'
    | 'error'
  currentVersion: string | null
  availableVersion: string | null
  notes: string | null
  publishedAt: string | null
  lastCheckedAt: string | null
  errorMessage: string | null
  downloadedBytes: number
  totalBytes: number | null
  lastTrigger: 'background' | 'manual' | null
}

type CheckForUpdatesOptions = {
  manual?: boolean
}

type CheckForUpdatesResult =
  | { kind: 'available' }
  | { kind: 'checking' }
  | { kind: 'downloaded' }
  | { kind: 'downloading' }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'upToDate' }

const initialState: AppUpdaterState = {
  status: 'idle',
  currentVersion: null,
  availableVersion: null,
  notes: null,
  publishedAt: null,
  lastCheckedAt: null,
  errorMessage: null,
  downloadedBytes: 0,
  totalBytes: null,
  lastTrigger: null,
}

type PendingUpdate = {
  version: string
  body?: string
  date?: string
  download: (onEvent?: (event: { event: string; data?: Record<string, number> }) => void) => Promise<void>
  install: () => Promise<void>
  close?: () => Promise<void>
}

export function useAppUpdater() {
  const [state, setState] = useState<AppUpdaterState>(initialState)
  const updateRef = useRef<PendingUpdate | null>(null)
  const inFlightRef = useRef(false)
  const unsupportedMessage = 'Automatic updates are only available in the packaged FalconDeck desktop app.'
  const devModeMessage = 'Updater checks are disabled in development builds.'

  useEffect(() => {
    if (!isTauriDesktop()) {
      setState((current) => ({
        ...current,
        status: 'unsupported',
        errorMessage: unsupportedMessage,
      }))
      return
    }

    if (import.meta.env.DEV) {
      void getVersion()
        .then((currentVersion) => {
          setState((current) => ({
            ...current,
            currentVersion,
            status: 'unsupported',
            errorMessage: devModeMessage,
          }))
        })
        .catch(() => {})
      return
    }

    void getVersion()
      .then((currentVersion) => {
        setState((current) => ({ ...current, currentVersion }))
      })
      .catch(() => {})
  }, [])

  const closeCachedUpdate = useCallback(() => {
    if (updateRef.current?.close) {
      void updateRef.current.close()
    }
    updateRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      closeCachedUpdate()
    }
  }, [closeCachedUpdate])

  const checkForUpdates = useCallback(
    async ({ manual = false }: CheckForUpdatesOptions = {}): Promise<CheckForUpdatesResult> => {
      if (!isTauriDesktop()) {
        setState((current) => ({
          ...current,
          status: 'unsupported',
          errorMessage: unsupportedMessage,
          lastTrigger: manual ? 'manual' : 'background',
        }))
        return { kind: 'unsupported', message: unsupportedMessage }
      }

      if (import.meta.env.DEV) {
        setState((current) => ({
          ...current,
          status: 'unsupported',
          errorMessage: devModeMessage,
          lastTrigger: manual ? 'manual' : 'background',
        }))
        return { kind: 'unsupported', message: devModeMessage }
      }

      if (!manual) {
        if (state.status === 'available') {
          return { kind: 'available' }
        }
        if (state.status === 'downloading') {
          return { kind: 'downloading' }
        }
        if (state.status === 'downloaded') {
          return { kind: 'downloaded' }
        }
      } else if (state.status === 'downloading') {
        return { kind: 'downloading' }
      } else if (state.status === 'downloaded') {
        return { kind: 'downloaded' }
      }

      if (inFlightRef.current) {
        return { kind: 'checking' }
      }

      inFlightRef.current = true

      try {
        const [{ check }, currentVersion] = await Promise.all([
          import('@tauri-apps/plugin-updater'),
          getVersion(),
        ])

        setState((current) => ({
          ...current,
          currentVersion,
          status: 'checking',
          errorMessage: null,
          downloadedBytes: 0,
          totalBytes: null,
          lastTrigger: manual ? 'manual' : 'background',
        }))

        const update = await check()
        const lastCheckedAt = new Date().toISOString()

        if (!update) {
          closeCachedUpdate()
          setState((current) => ({
            ...current,
            currentVersion,
            status: 'upToDate',
            availableVersion: null,
            notes: null,
            publishedAt: null,
            errorMessage: null,
            downloadedBytes: 0,
            totalBytes: null,
            lastCheckedAt,
            lastTrigger: manual ? 'manual' : 'background',
          }))
          return { kind: 'upToDate' }
        }

        closeCachedUpdate()
        updateRef.current = update as PendingUpdate
        setState((current) => ({
          ...current,
          currentVersion,
          status: 'available',
          availableVersion: update.version,
          notes: update.body ?? null,
          publishedAt: update.date ?? null,
          errorMessage: null,
          downloadedBytes: 0,
          totalBytes: null,
          lastCheckedAt,
          lastTrigger: manual ? 'manual' : 'background',
        }))

        return { kind: 'available' }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to check for updates'
        setState((current) => ({
          ...current,
          status:
            current.status === 'available' ||
            current.status === 'downloading' ||
            current.status === 'downloaded'
              ? current.status
              : 'error',
          errorMessage: message,
          lastCheckedAt: new Date().toISOString(),
          lastTrigger: manual ? 'manual' : 'background',
        }))
        return { kind: 'error', message }
      } finally {
        inFlightRef.current = false
      }
    },
    [closeCachedUpdate, devModeMessage, state.status, unsupportedMessage],
  )

  useEffect(() => {
    if (!isTauriDesktop() || import.meta.env.DEV) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      void checkForUpdates()
    }, INITIAL_UPDATE_CHECK_DELAY_MS)

    const intervalId = window.setInterval(() => {
      void checkForUpdates()
    }, AUTO_UPDATE_CHECK_INTERVAL_MS)

    return () => {
      window.clearTimeout(timeoutId)
      window.clearInterval(intervalId)
    }
  }, [checkForUpdates])

  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current
    if (!update) {
      throw new Error('No pending update is ready to download.')
    }

    setState((current) => ({
      ...current,
      status: 'downloading',
      errorMessage: null,
      downloadedBytes: 0,
      totalBytes: null,
    }))

    try {
      await update.download((event) => {
        if (event.event === 'Started') {
          setState((current) => ({
            ...current,
            totalBytes: typeof event.data?.contentLength === 'number' ? event.data.contentLength : null,
          }))
          return
        }

        if (event.event === 'Progress') {
          setState((current) => ({
            ...current,
            downloadedBytes: current.downloadedBytes + (event.data?.chunkLength ?? 0),
          }))
        }
      })
      await update.install()
      closeCachedUpdate()
      setState((current) => ({
        ...current,
        status: 'downloaded',
        errorMessage: null,
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download the update'
      closeCachedUpdate()
      setState((current) => ({
        ...current,
        status: 'error',
        errorMessage: message,
        downloadedBytes: 0,
        totalBytes: null,
      }))
      throw error
    }
  }, [closeCachedUpdate])

  const restartToInstall = useCallback(async () => {
    await restartDesktopApp()
  }, [])

  const progressPercent = useMemo(() => {
    if (!state.totalBytes || state.totalBytes <= 0) return null
    return Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
  }, [state.downloadedBytes, state.totalBytes])

  return {
    state,
    progressPercent,
    autoCheckIntervalMs: AUTO_UPDATE_CHECK_INTERVAL_MS,
    checkForUpdates,
    downloadAndInstall,
    restartToInstall,
  }
}
