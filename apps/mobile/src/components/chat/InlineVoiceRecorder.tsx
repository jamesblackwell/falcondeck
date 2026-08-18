import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'
import { Directory, File, Paths } from 'expo-file-system'
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio'
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition'
import { useRouter, type Href } from 'expo-router'
import { ArrowUp, RotateCcw, Settings, Square, Trash2, X } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { ActivityDiamond, Text } from '@/components/ui'
import {
  clearPendingVoiceRecording,
  getPendingVoiceRecording,
  getSpeechSettings,
  setPendingVoiceRecording,
  updateSpeechSettings,
  type SpeechProvider,
} from '@/features/speech/speechSettings'
import {
  getDesktopSpeechStatus,
  transcribeWithDesktopOpenRouter,
} from '@/features/speech/openRouterTranscription'

import { VoiceWaveform } from './VoiceWaveform'

type VoiceState = 'starting' | 'recording' | 'transcribing' | 'failed'

// Painted size of the round controls; hitSlop lifts them to 44pt.
const CONTROL_SIZE = 40
const MIN_ROW_HEIGHT = 48
const LEVEL_HISTORY_LIMIT = 120

function recordingDirectory(): Directory {
  const directory = new Directory(Paths.document, 'voice-drafts')
  directory.create({ intermediates: true, idempotent: true })
  return directory
}

function moveCloudRecording(uri: string): string {
  const source = new File(uri)
  const extension =
    uri.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase() || 'm4a'
  const destination = new File(
    recordingDirectory(),
    `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`,
  )
  source.move(destination)
  return destination.uri
}

function removeRecording(uri: string | null): void {
  if (!uri) return
  const file = new File(uri)
  if (file.exists) file.delete()
}

function durationLabel(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Recorder metering is dBFS; treat -50 dB and below as silence. */
function meteringToLevel(db: number): number {
  return Math.min(1, Math.max(0, 1 + db / 50))
}

/** Speech-recognition volume is -2..10; below 0 is inaudible. */
function volumeToLevel(value: number): number {
  return Math.min(1, Math.max(0, value / 10))
}

/**
 * In-composer voice recording session: cancel, live waveform and duration,
 * then the same stop/send pair the composer footer shows — stop drops the
 * transcript into the draft to edit, send fires it off as soon as it lands.
 * Replaces the composer's input and footer rows while active; failures stay
 * inline with retry/discard so the recording is never silently lost.
 */
export function InlineVoiceRecorder({
  provider: initialProvider,
  onTranscript,
  onClose,
}: {
  provider: SpeechProvider
  onTranscript: (text: string, options?: { submit?: boolean }) => void
  onClose: () => void
}) {
  const { theme } = useUnistyles()
  const router = useRouter()
  const [initialPending] = useState(() => getPendingVoiceRecording())
  const settingsRef = useRef(getSpeechSettings())
  const [provider, setProvider] = useState<SpeechProvider>(
    initialPending?.provider ?? initialProvider,
  )
  const [recordingProvider, setRecordingProvider] =
    useState<SpeechProvider | null>(initialPending?.provider ?? null)
  const [state, setState] = useState<VoiceState>(
    initialPending ? 'failed' : 'starting',
  )
  const [error, setError] = useState<string | null>(
    initialPending ? 'A previous recording is waiting to be transcribed.' : null,
  )
  const [recordingUri, setRecordingUri] = useState<string | null>(
    initialPending?.uri ?? null,
  )
  const [levels, setLevels] = useState<number[]>([])
  const [localSeconds, setLocalSeconds] = useState(0)
  const transcriptRef = useRef('')
  const finalizedTranscriptRef = useRef('')
  const cancelledRef = useRef(false)
  // Which control ended the recording. Transcription finishes asynchronously
  // (and, on device, via a module event), so the intent has to outlive the tap.
  const submitOnFinishRef = useRef(false)
  const localErrorRef = useRef(false)
  const startedRef = useRef(false)
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  })
  const recorderState = useAudioRecorderState(recorder, 150)

  const pushLevel = useCallback((level: number) => {
    setLevels((previous) => [...previous.slice(-(LEVEL_HISTORY_LIMIT - 1)), level])
  }, [])

  useEffect(() => {
    if (state !== 'recording' || provider !== 'openrouter') return
    if (typeof recorderState.metering === 'number') {
      pushLevel(meteringToLevel(recorderState.metering))
    }
  }, [provider, pushLevel, recorderState, state])

  // The speech-recognition module reports no elapsed time, so count it here.
  useEffect(() => {
    if (state !== 'recording' || provider === 'openrouter') return
    const startedAt = Date.now()
    setLocalSeconds(0)
    const timer = setInterval(
      () => setLocalSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      250,
    )
    return () => clearInterval(timer)
  }, [provider, state])

  const finishWithTranscript = useCallback(
    (text: string, completedRecordingUri?: string) => {
      const cleaned = text.trim()
      if (!cleaned) {
        setError(
          'No speech was detected. Your recording is safe, so you can retry.',
        )
        setState('failed')
        return
      }
      removeRecording(
        completedRecordingUri ??
          recordingUri ??
          getPendingVoiceRecording()?.uri ??
          null,
      )
      clearPendingVoiceRecording()
      onTranscript(cleaned, { submit: submitOnFinishRef.current })
      onClose()
    },
    [onClose, onTranscript, recordingUri],
  )

  const transcribeCloud = useCallback(
    async (uri: string) => {
      setState('transcribing')
      setError(null)
      try {
        const result = await transcribeWithDesktopOpenRouter({
          uri,
          model: settingsRef.current.model,
          language: settingsRef.current.language,
        })
        if (cancelledRef.current) return
        finishWithTranscript(result.text, uri)
      } catch (cause) {
        if (cancelledRef.current) return
        setError(
          cause instanceof Error
            ? cause.message
            : 'Transcription failed. Your recording is safe.',
        )
        setState('failed')
      }
    },
    [finishWithTranscript],
  )

  const startCloud = useCallback(async () => {
    setState('starting')
    setError(null)
    try {
      const permission = await requestRecordingPermissionsAsync()
      if (cancelledRef.current) return
      if (!permission.granted)
        throw new Error('Microphone access is required to record speech.')
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      })
      if (cancelledRef.current) {
        await setAudioModeAsync({ allowsRecording: false })
        return
      }
      await recorder.prepareToRecordAsync()
      if (cancelledRef.current) {
        await setAudioModeAsync({ allowsRecording: false })
        return
      }
      recorder.record()
      setState('recording')
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not start recording.',
      )
      setState('failed')
    }
  }, [recorder])

  const startOnDevice = useCallback(async (audioUri?: string) => {
    setState('starting')
    setError(null)
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setError('Speech recognition is unavailable on this device.')
      setState('failed')
      return
    }
    if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) {
      setError(
        'This device does not currently have on-device speech recognition available.',
      )
      setState('failed')
      return
    }
    if (!audioUri) {
      const permission =
        await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync()
      if (cancelledRef.current) return
      if (!permission.granted) {
        setError(
          'Microphone access is required to use on-device speech recognition.',
        )
        setState('failed')
        return
      }
    }
    transcriptRef.current = ''
    finalizedTranscriptRef.current = ''
    localErrorRef.current = false
    const directory = recordingDirectory()
    ExpoSpeechRecognitionModule.start({
      lang: settingsRef.current.language ?? undefined,
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: true,
      addsPunctuation: true,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 150 },
      audioSource: audioUri
        ? {
            uri: audioUri,
            audioChannels: 1,
            sampleRate: 16_000,
          }
        : undefined,
      recordingOptions:
        !audioUri && ExpoSpeechRecognitionModule.supportsRecording()
          ? {
              persist: true,
              outputDirectory: directory.uri,
              outputFileName: `voice-${Date.now()}.wav`,
              outputSampleRate: 16_000,
              outputEncoding: 'pcmFormatInt16',
            }
          : undefined,
    })
  }, [])

  const begin = useCallback(
    async (nextProvider: SpeechProvider) => {
      setProvider(nextProvider)
      settingsRef.current = updateSpeechSettings({ provider: nextProvider })
      if (nextProvider === 'openrouter') {
        try {
          const status = await getDesktopSpeechStatus()
          if (cancelledRef.current) return
          if (!status.configured) {
            setError(
              'Add your OpenRouter API key in FalconDeck desktop settings first.',
            )
            setState('failed')
            return
          }
          await startCloud()
        } catch (cause) {
          if (cancelledRef.current) return
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not reach the paired desktop.',
          )
          setState('failed')
        }
      } else {
        await startOnDevice()
      }
    },
    [startCloud, startOnDevice],
  )

  useEffect(() => {
    if (startedRef.current || initialPending) return
    startedRef.current = true
    void begin(initialProvider)
  }, [begin, initialPending, initialProvider])

  useSpeechRecognitionEvent('start', () => setState('recording'))
  useSpeechRecognitionEvent('result', (event) => {
    const text = event.results[0]?.transcript?.trim()
    if (!text) return
    if (event.isFinal) {
      finalizedTranscriptRef.current = [finalizedTranscriptRef.current, text]
        .filter(Boolean)
        .join(' ')
      transcriptRef.current = finalizedTranscriptRef.current
    } else {
      transcriptRef.current = [finalizedTranscriptRef.current, text]
        .filter(Boolean)
        .join(' ')
    }
  })
  useSpeechRecognitionEvent('volumechange', (event) => {
    pushLevel(volumeToLevel(event.value))
  })
  useSpeechRecognitionEvent('audioend', (event) => {
    if (!event.uri) return
    setRecordingUri(event.uri)
    setRecordingProvider('on-device')
    setPendingVoiceRecording(event.uri, 'on-device')
  })
  useSpeechRecognitionEvent('error', (event) => {
    if (cancelledRef.current || event.error === 'aborted') return
    localErrorRef.current = true
    setError(event.message || 'On-device speech recognition failed.')
    setState('failed')
  })
  useSpeechRecognitionEvent('end', () => {
    if (cancelledRef.current || localErrorRef.current) return
    finishWithTranscript(transcriptRef.current)
  })

  const stopRecording = useCallback(async (submit: boolean) => {
    submitOnFinishRef.current = submit
    if (provider === 'on-device') {
      ExpoSpeechRecognitionModule.stop()
      setState('transcribing')
      return
    }
    setState('transcribing')
    try {
      await recorder.stop()
      if (!recorder.uri)
        throw new Error('The recorder did not produce an audio file.')
      const uri = moveCloudRecording(recorder.uri)
      setRecordingUri(uri)
      setRecordingProvider('openrouter')
      setPendingVoiceRecording(uri, 'openrouter')
      await setAudioModeAsync({ allowsRecording: false })
      await transcribeCloud(uri)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not finish recording.',
      )
      setState('failed')
    }
  }, [provider, recorder, transcribeCloud])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    if (
      provider === 'on-device' &&
      (state === 'recording' || state === 'starting')
    ) {
      ExpoSpeechRecognitionModule.abort()
    } else if (provider === 'openrouter' && recorder.isRecording) {
      void recorder.stop().then(() => {
        if (recorder.uri) {
          const uri = moveCloudRecording(recorder.uri)
          setRecordingUri(uri)
          setRecordingProvider('openrouter')
          setPendingVoiceRecording(uri, 'openrouter')
        }
        return setAudioModeAsync({ allowsRecording: false })
      })
    }
    onClose()
  }, [onClose, provider, recorder, state])

  const retry = useCallback(async () => {
    submitOnFinishRef.current = false
    if (recordingUri) {
      if (recordingProvider === 'on-device') {
        setProvider('on-device')
        await startOnDevice(recordingUri)
        return
      }
      try {
        const status = await getDesktopSpeechStatus()
        if (cancelledRef.current) return
        if (!status.configured) {
          setError(
            'This saved recording needs OpenRouter. Add the API key on your desktop, or discard it and record on-device.',
          )
          setState('failed')
          return
        }
        setProvider('openrouter')
        await transcribeCloud(recordingUri)
      } catch (cause) {
        if (cancelledRef.current) return
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not reach the paired desktop.',
        )
        setState('failed')
      }
      return
    }
    await begin(provider)
  }, [
    begin,
    provider,
    recordingProvider,
    recordingUri,
    startOnDevice,
    transcribeCloud,
  ])

  const discardAndRecord = useCallback(() => {
    removeRecording(recordingUri)
    clearPendingVoiceRecording()
    setRecordingUri(null)
    setRecordingProvider(null)
    setLevels([])
    void begin(settingsRef.current.provider ?? initialProvider)
  }, [begin, initialProvider, recordingUri])

  const openSpeechSettings = useCallback(() => {
    onClose()
    router.push('/(app)/settings/speech' as Href)
  }, [onClose, router])

  const displaySeconds =
    provider === 'openrouter'
      ? Math.floor(recorderState.durationMillis / 1000)
      : localSeconds

  return (
    <View style={styles.row}>
      <Pressable
        style={styles.dismissButton}
        onPress={cancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel voice input"
        hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
      >
        <X size={theme.iconSize.md} color={theme.colors.fg.muted} />
      </Pressable>

      {state === 'failed' ? (
        <>
          <Text
            variant="caption"
            color="danger"
            size="xs"
            style={styles.error}
            numberOfLines={3}
            accessibilityLiveRegion="polite"
          >
            {error ?? 'Voice input failed.'}
          </Text>
          <Pressable
            style={styles.ghostButton}
            onPress={openSpeechSettings}
            accessibilityRole="button"
            accessibilityLabel="Speech settings"
            hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
          >
            <Settings size={theme.iconSize.sm} color={theme.colors.fg.muted} />
          </Pressable>
          {recordingUri ? (
            <Pressable
              style={styles.ghostButton}
              onPress={discardAndRecord}
              accessibilityRole="button"
              accessibilityLabel="Discard recording and record again"
              hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
            >
              <Trash2
                size={theme.iconSize.sm}
                color={theme.colors.danger.default}
              />
            </Pressable>
          ) : null}
          <Pressable
            style={styles.confirmButton}
            onPress={() => void retry()}
            accessibilityRole="button"
            accessibilityLabel={
              recordingUri ? 'Retry transcription' : 'Try recording again'
            }
            hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
          >
            <RotateCcw
              size={theme.iconSize.md}
              color={theme.colors.surface[0]}
            />
          </Pressable>
        </>
      ) : (
        <>
          <VoiceWaveform levels={levels} muted={state === 'transcribing'} />
          {state === 'transcribing' ? (
            <Text
              variant="caption"
              color="secondary"
              size="xs"
              accessibilityLiveRegion="polite"
            >
              Transcribing…
            </Text>
          ) : (
            <Text
              variant="caption"
              color="secondary"
              size="xs"
              style={styles.duration}
              accessibilityLabel={`Recording, ${durationLabel(displaySeconds)}`}
            >
              {durationLabel(displaySeconds)}
            </Text>
          )}
          {state === 'transcribing' ? (
            <View style={styles.busyButton}>
              <ActivityDiamond color={theme.colors.fg.muted} />
            </View>
          ) : (
            <>
              <Pressable
                style={[
                  styles.stopButton,
                  state !== 'recording' && styles.confirmIdle,
                ]}
                onPress={() => void stopRecording(false)}
                disabled={state !== 'recording'}
                accessibilityRole="button"
                accessibilityLabel="Stop and transcribe"
                accessibilityHint="Puts the transcript in the composer to edit"
                accessibilityState={{ disabled: state !== 'recording' }}
                hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
              >
                <Square
                  size={theme.iconSize.md - 6}
                  color={theme.colors.fg.primary}
                  fill={theme.colors.fg.primary}
                />
              </Pressable>
              <Pressable
                style={[
                  styles.confirmButton,
                  state !== 'recording' && styles.confirmIdle,
                ]}
                onPress={() => void stopRecording(true)}
                disabled={state !== 'recording'}
                accessibilityRole="button"
                accessibilityLabel="Transcribe and send"
                accessibilityState={{ disabled: state !== 'recording' }}
                hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
              >
                <ArrowUp
                  size={theme.iconSize.md}
                  color={theme.colors.surface[0]}
                />
              </Pressable>
            </>
          )}
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: MIN_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  dismissButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface[3],
  },
  ghostButton: {
    width: CONTROL_SIZE - 8,
    height: CONTROL_SIZE - 8,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface[3],
  },
  confirmButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent.default,
  },
  confirmIdle: {
    opacity: 0.5,
  },
  busyButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  duration: {
    fontVariant: ['tabular-nums'],
  },
  error: {
    flex: 1,
  },
}))
