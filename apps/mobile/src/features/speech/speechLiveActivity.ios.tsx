import { Button, HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui'
import {
  background,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  monospacedDigit,
  padding,
  shapes,
  tint,
} from '@expo/ui/swift-ui/modifiers'
import {
  addUserInteractionListener,
  createLiveActivity,
  type LiveActivity,
  type LiveActivityLayout,
} from 'expo-widgets'

import type {
  SpeechActivityAction,
  SpeechActivityActionListener,
  SpeechActivityMode,
  SpeechLiveActivityController,
} from './speechLiveActivity.types'

type SpeechActivityProps = {
  mode: SpeechActivityMode
  startedAt: number
  pausedAt?: number
}

const ACTIVITY_NAME = 'FalconDeckSpeechActivity'
const ACTIVITY_DEEP_LINK = 'falcondeck:///'
const VALID_ACTIONS = new Set<SpeechActivityAction>([
  'finish-recording',
  'cancel-recording',
  'toggle-playback',
  'stop-playback',
])

function SpeechActivity(props: SpeechActivityProps): LiveActivityLayout {
  'widget'

  const isListening = props.mode === 'listening'
  const isTranscribing = props.mode === 'transcribing'
  const isPaused = props.mode === 'paused'
  const status = isListening
    ? 'Listening…'
    : isTranscribing
      ? 'Transcribing…'
      : isPaused
        ? 'Read Aloud paused'
        : 'Reading response…'
  const symbol = isListening
    ? 'mic.fill'
    : isTranscribing
      ? 'waveform.badge.magnifyingglass'
      : isPaused
        ? 'pause.fill'
        : 'waveform'
  const timer = isTranscribing ? null : (
    <Text
      date={new Date(props.startedAt)}
      dateStyle="timer"
      pauseTime={props.pausedAt ? new Date(props.pausedAt) : undefined}
      modifiers={[
        font({ size: 15, weight: 'semibold', design: 'rounded' }),
        monospacedDigit(),
        foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
      ]}
    />
  )

  return {
    banner: (
      <VStack
        spacing={14}
        modifiers={[
          frame({ maxWidth: 1_000, alignment: 'leading' }),
          padding({ all: 16 }),
          background('#17171B', shapes.roundedRectangle({ cornerRadius: 24 })),
        ]}
      >
        <HStack spacing={12} alignment="center">
          <Image systemName="diamond.fill" size={34} color="#E5484D" />
          <VStack spacing={2} alignment="leading">
            <Text
              modifiers={[
                font({ size: 17, weight: 'bold' }),
                foregroundStyle('#FFFFFF'),
              ]}
            >
              FalconDeck
            </Text>
            <Text
              modifiers={[
                font({ size: 15 }),
                foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
              ]}
            >
              {status}
            </Text>
          </VStack>
          <Spacer />
          {timer}
        </HStack>
        {isListening ? (
          <HStack spacing={10}>
            <Button
              label="Finish"
              systemImage="stop.fill"
              target="finish-recording"
              modifiers={[
                frame({ maxWidth: 1_000 }),
                buttonStyle('borderedProminent'),
                tint('#E5484D'),
              ]}
            />
            <Button
              label="Cancel"
              systemImage="xmark"
              role="destructive"
              target="cancel-recording"
              modifiers={[frame({ maxWidth: 1_000 }), buttonStyle('bordered')]}
            />
          </HStack>
        ) : isTranscribing ? null : (
          <HStack spacing={10}>
            <Button
              label={isPaused ? 'Resume' : 'Pause'}
              systemImage={isPaused ? 'play.fill' : 'pause.fill'}
              target="toggle-playback"
              modifiers={[
                frame({ maxWidth: 1_000 }),
                buttonStyle('borderedProminent'),
                tint('#E5484D'),
              ]}
            />
            <Button
              label="Stop"
              systemImage="xmark"
              role="destructive"
              target="stop-playback"
              modifiers={[frame({ maxWidth: 1_000 }), buttonStyle('bordered')]}
            />
          </HStack>
        )}
      </VStack>
    ),
    compactLeading: <Image systemName={symbol} size={16} color="#E5484D" />,
    compactTrailing: timer,
    minimal: <Image systemName={symbol} size={16} color="#E5484D" />,
    expandedLeading: (
      <Image
        systemName="diamond.fill"
        size={28}
        color="#E5484D"
        modifiers={[padding({ leading: 8, top: 8 })]}
      />
    ),
    expandedCenter: (
      <VStack spacing={2} alignment="leading" modifiers={[padding({ top: 8 })]}>
        <Text modifiers={[font({ size: 15, weight: 'bold' })]}>FalconDeck</Text>
        <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
          {status}
        </Text>
      </VStack>
    ),
    expandedTrailing: (
      <VStack modifiers={[padding({ trailing: 8, top: 8 })]}>{timer}</VStack>
    ),
    expandedBottom: isListening ? (
      <HStack spacing={10} modifiers={[padding({ horizontal: 8, bottom: 8 })]}>
        <Button
          label="Finish"
          systemImage="stop.fill"
          target="finish-recording"
          modifiers={[
            frame({ maxWidth: 1_000 }),
            buttonStyle('borderedProminent'),
            tint('#E5484D'),
          ]}
        />
        <Button
          label="Cancel"
          systemImage="xmark"
          role="destructive"
          target="cancel-recording"
          modifiers={[frame({ maxWidth: 1_000 }), buttonStyle('bordered')]}
        />
      </HStack>
    ) : isTranscribing ? null : (
      <HStack spacing={10} modifiers={[padding({ horizontal: 8, bottom: 8 })]}>
        <Button
          label={isPaused ? 'Resume' : 'Pause'}
          systemImage={isPaused ? 'play.fill' : 'pause.fill'}
          target="toggle-playback"
          modifiers={[
            frame({ maxWidth: 1_000 }),
            buttonStyle('borderedProminent'),
            tint('#E5484D'),
          ]}
        />
        <Button
          label="Stop"
          systemImage="xmark"
          role="destructive"
          target="stop-playback"
          modifiers={[frame({ maxWidth: 1_000 }), buttonStyle('bordered')]}
        />
      </HStack>
    ),
  }
}

const SpeechActivityFactory = createLiveActivity<SpeechActivityProps>(
  ACTIVITY_NAME,
  SpeechActivity,
)

class IosSpeechLiveActivity implements SpeechLiveActivityController {
  private activity: LiveActivity<SpeechActivityProps> | null = null
  private props: SpeechActivityProps | null = null
  private readonly listeners = new Set<SpeechActivityActionListener>()
  private interactionSubscription: { remove(): void } | null = null
  private initialized = false

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    for (const staleActivity of SpeechActivityFactory.getInstances()) {
      void staleActivity.end('immediate').catch(() => undefined)
    }
    this.interactionSubscription = addUserInteractionListener((event) => {
      if (event.source !== ACTIVITY_NAME || !VALID_ACTIONS.has(event.target as SpeechActivityAction)) {
        return
      }
      const action = event.target as SpeechActivityAction
      this.listeners.forEach((listener) => listener(action))
    })
  }

  startListening(startedAt = Date.now()): void {
    this.start({ mode: 'listening', startedAt })
  }

  startPlaying(startedAt = Date.now()): void {
    this.start({ mode: 'playing', startedAt })
  }

  setMode(mode: SpeechActivityMode): void {
    if (!this.activity || !this.props) return
    this.props = {
      ...this.props,
      mode,
      pausedAt: mode === 'paused' ? Date.now() : undefined,
    }
    void this.activity.update(this.props).catch(() => undefined)
  }

  end(): void {
    const activity = this.activity
    this.activity = null
    this.props = null
    if (activity) void activity.end('immediate').catch(() => undefined)
  }

  subscribeAction(listener: SpeechActivityActionListener): () => void {
    this.initialize()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private start(props: SpeechActivityProps): void {
    this.initialize()
    this.end()
    try {
      this.activity = SpeechActivityFactory.start(props, ACTIVITY_DEEP_LINK)
      this.props = props
    } catch {
      // Live Activities can be disabled or unavailable on older iOS versions.
      this.activity = null
      this.props = null
    }
  }
}

export const speechLiveActivity = new IosSpeechLiveActivity()

export type {
  SpeechActivityAction,
  SpeechActivityActionListener,
  SpeechActivityMode,
} from './speechLiveActivity.types'
