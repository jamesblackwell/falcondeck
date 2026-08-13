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
import { Mic, RotateCcw, Square, Trash2 } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { Button, NativeSheet, Text } from '@/components/ui'
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

type VoiceState =
  'choosing' | 'starting' | 'recording' | 'transcribing' | 'failed'

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

function durationLabel(durationMillis: number): string {
  const seconds = Math.max(0, Math.floor(durationMillis / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function VoiceInputSheet({
  onTranscript,
  onClose,
}: {
  onTranscript: (text: string) => void
  onClose: () => void
}) {
  const { theme } = useUnistyles()
  const router = useRouter()
  const [initial] = useState(() => ({
    settings: getSpeechSettings(),
    pending: getPendingVoiceRecording(),
  }))
  const settingsRef = useRef(initial.settings)
  const initialProvider = initial.settings.provider
  const initialPendingProvider = initial.pending?.provider ?? null
  const [provider, setProvider] = useState<SpeechProvider | null>(
    initialPendingProvider ?? initialProvider,
  )
  const [recordingProvider, setRecordingProvider] =
    useState<SpeechProvider | null>(initialPendingProvider)
  const [state, setState] = useState<VoiceState>(
    initial.pending ? 'failed' : initialProvider ? 'starting' : 'choosing',
  )
  const [error, setError] = useState<string | null>(
    initial.pending
      ? 'A previous recording is waiting to be transcribed.'
      : null,
  )
  const [recordingUri, setRecordingUri] = useState<string | null>(
    initial.pending?.uri ?? null,
  )
  const transcriptRef = useRef('')
  const finalizedTranscriptRef = useRef('')
  const cancelledRef = useRef(false)
  const localErrorRef = useRef(false)
  const startedRef = useRef(false)
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY)
  const recorderState = useAudioRecorderState(recorder, 250)

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
      onTranscript(cleaned)
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
    if (startedRef.current || initial.pending || !initialProvider) return
    startedRef.current = true
    void begin(initialProvider)
  }, [begin, initial.pending, initialProvider])

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

  const stopRecording = useCallback(async () => {
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

  const discard = useCallback(() => {
    removeRecording(recordingUri)
    clearPendingVoiceRecording()
    onClose()
  }, [onClose, recordingUri])

  const retry = useCallback(async () => {
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
    if (provider) await begin(provider)
  }, [
    begin,
    provider,
    recordingProvider,
    recordingUri,
    startOnDevice,
    transcribeCloud,
  ])

  const discardAndRecordOnDevice = useCallback(() => {
    removeRecording(recordingUri)
    clearPendingVoiceRecording()
    setRecordingUri(null)
    setRecordingProvider(null)
    settingsRef.current = updateSpeechSettings({ provider: 'on-device' })
    setProvider('on-device')
    void startOnDevice()
  }, [recordingUri, startOnDevice])

  return (
    <NativeSheet
      onClose={cancel}
      accessibilityLabel="Close voice input"
      contentStyle={styles.content}
    >
      <View style={styles.header}>
        <Text size="lg" weight="semibold">
          Voice input
        </Text>
        <Text variant="caption" color="muted">
          {state === 'choosing'
            ? 'Choose how FalconDeck should turn speech into text.'
            : provider === 'on-device'
              ? 'Speech stays on this device.'
              : 'Audio is encrypted to your desktop, which sends it to OpenRouter.'}
        </Text>
      </View>

      {state === 'choosing' ? (
        <View style={styles.choices}>
          <Pressable
            style={styles.choice}
            onPress={() => void begin('on-device')}
            accessibilityRole="button"
            accessibilityLabel="Use on-device speech recognition"
          >
            <Text variant="label">On-device</Text>
            <Text variant="caption" color="muted">
              Private and offline when your phone has a downloaded speech model.
            </Text>
          </Pressable>
          <Pressable
            style={styles.choice}
            onPress={() => void begin('openrouter')}
            accessibilityRole="button"
            accessibilityLabel="Set up OpenRouter speech recognition"
          >
            <Text variant="label">OpenRouter</Text>
            <Text variant="caption" color="muted">
              Use the API key held securely by your paired desktop.
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.recorder}>
          <View
            style={[
              styles.micCircle,
              state === 'recording' ? styles.micCircleActive : null,
            ]}
          >
            {state === 'recording' ? (
              <Square
                size={theme.iconSize.xl}
                color={theme.colors.surface[0]}
                fill={theme.colors.surface[0]}
              />
            ) : (
              <Mic size={theme.iconSize.xl} color={theme.colors.fg.primary} />
            )}
          </View>
          <Text variant="label" accessibilityLiveRegion="polite">
            {state === 'starting'
              ? 'Starting…'
              : state === 'recording'
                ? `Recording ${provider === 'openrouter' ? durationLabel(recorderState.durationMillis) : ''}`
                : state === 'transcribing'
                  ? 'Transcribing…'
                  : 'Recording saved'}
          </Text>
          {error ? (
            <Text variant="caption" color="danger" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {state === 'recording' ? (
            <Button
              label="Stop and transcribe"
              onPress={() => void stopRecording()}
            />
          ) : null}
          {state === 'failed' ? (
            <View style={styles.actions}>
              {recordingUri &&
              recordingProvider === 'openrouter' &&
              initialProvider === 'on-device' ? (
                <Button
                  label="Discard and record on-device"
                  icon={
                    <Mic
                      size={theme.iconSize.sm}
                      color={theme.colors.surface[0]}
                    />
                  }
                  onPress={discardAndRecordOnDevice}
                />
              ) : (
                <Button
                  label={recordingUri ? 'Retry transcription' : 'Try again'}
                  icon={
                    <RotateCcw
                      size={theme.iconSize.sm}
                      color={theme.colors.surface[0]}
                    />
                  }
                  onPress={() => void retry()}
                />
              )}
              {recordingUri ? (
                <Button
                  variant="ghost"
                  label="Discard recording"
                  icon={
                    <Trash2
                      size={theme.iconSize.sm}
                      color={theme.colors.danger.default}
                    />
                  }
                  onPress={discard}
                />
              ) : null}
              <Button
                variant="ghost"
                label="Speech settings"
                onPress={() => {
                  onClose()
                  router.push('/(app)/settings/speech' as Href)
                }}
              />
            </View>
          ) : null}
        </View>
      )}
    </NativeSheet>
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    paddingHorizontal: theme.spacing[5],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[4],
  },
  header: { gap: theme.spacing[1] },
  choices: { gap: theme.spacing[3] },
  choice: {
    minHeight: theme.minTouchTarget,
    padding: theme.spacing[4],
    gap: theme.spacing[1],
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.surface[2],
    borderWidth: 1,
    borderColor: theme.colors.border.default,
  },
  recorder: {
    alignItems: 'center',
    gap: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  micCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface[3],
  },
  micCircleActive: { backgroundColor: theme.colors.danger.default },
  error: { textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: theme.spacing[2] },
}))
