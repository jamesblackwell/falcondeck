import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { View, TextInput, Pressable, useWindowDimensions } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { BookOpen, Mic, Plus, Send, Square, Target } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import {
  activeSlashQuery,
  filterSlashSkills,
  insertTranscript,
  NO_AGENT_CAPABILITIES,
  type ActiveSlashQuery,
  type AgentCapabilitySummary,
  type AgentProvider,
  type ImageInput,
  type ModelSummary,
  type ProviderOption,
  type SkillSummary,
} from '@falcondeck/client-core'

import {
  GlassSurface,
  glassEdge,
  glassFill,
  OptionSheet,
  Text,
  type OptionSheetItem,
} from '@/components/ui'

import {
  getPendingVoiceRecording,
  getSpeechSettings,
  type SpeechProvider,
} from '@/features/speech/speechSettings'
import { triggerComposerSelectionHaptic } from '@/lib/haptics'

import { AttachmentPreviewList } from './AttachmentPreviewList'
import { InputToolbar } from './InputToolbar'
import { InlineVoiceRecorder } from './InlineVoiceRecorder'
import {
  SANDBOX_DEFAULT_VALUE,
  permissionChipLabel,
  permissionModeItems,
  sandboxChipLabel,
  sandboxModeItems,
} from './composerModes'

interface ChatInputProps {
  value: string
  onChangeText: (text: string) => void
  onSubmit: () => void
  /** Interrupt the active turn. When set and the thread is running with an empty draft, the primary button becomes Stop. */
  onStop?: () => void
  onPickImages: () => void
  onPasteImage?: () => void
  onTakePhoto?: () => void
  onRemoveAttachment: (attachmentId: string) => void
  /** Locks all composer editing, for example when no workspace exists. */
  disabled?: boolean
  /** Keeps drafting available while the current transport cannot submit. */
  sendDisabled?: boolean
  /** Accessible explanation for a temporarily unavailable send/stop action. */
  sendDisabledReason?: string
  placeholder?: string
  attachments: ImageInput[]
  skills: SkillSummary[]
  loadSkills?: (provider: AgentProvider) => Promise<SkillSummary[]>
  models: ModelSummary[]
  selectedModel: string | null
  selectedEffort: string | null
  effortOptions: string[]
  selectedProvider: AgentProvider
  providers?: ProviderOption[]
  showProviderSelector: boolean
  onSelectModel: (modelId: string | null) => void
  onSelectEffort: (effort: string | null) => void
  onSelectProvider: (provider: AgentProvider) => void
  /** Other agents offered as linked-thread destinations on an existing thread. */
  handoffProviders?: ProviderOption[]
  onHandoffProviderSelect?: (provider: AgentProvider) => void
  handoffDisabledReason?: string | null
  /** Tier id while fast mode is on; null is the provider's standard tier. */
  selectedServiceTier?: string | null
  onSelectServiceTier?: (tier: string | null) => void
  /** True while the selected thread has an in-flight turn. */
  isRunning?: boolean
  /** True while the harness model catalog is still hydrating. */
  modelsLoading?: boolean
  /** True while an interrupt request is in flight. */
  isStopping?: boolean
  capabilities?: AgentCapabilitySummary
  /** Shows the native /compact command for an existing compactable thread. */
  compactCommandAvailable?: boolean
  selectedPermissionMode?: string | null
  selectedSandboxMode?: string | null
  onSelectPermissionMode?: (mode: string | null) => void
  onSelectSandboxMode?: (mode: string | null) => void
  /** Opens the provider goal surface after consuming an active /goal query. */
  onGoalCommand?: () => void
  /** Lets the host focus the input imperatively, e.g. on a new conversation. */
  textInputRef?: RefObject<TextInput | null>
}

const MIN_INPUT_HEIGHT = 48
const MAX_INPUT_HEIGHT = 280
// A tall draft (plus attachment previews and the footer) can grow the card
// past the space left above the keyboard; once the message list has shrunk
// to nothing the overflow — the send button — slides under the keyboard.
// Cap growth to a fraction of the window so the composer always fits.
const MAX_INPUT_HEIGHT_WINDOW_FRACTION = 0.25
// Painted size of the attach/send buttons; hitSlop lifts them to 44pt.
const CONTROL_SIZE = 40
const DEFAULT_PROVIDER_OPTIONS: ProviderOption[] = [
  { provider: 'codex', label: 'Codex' },
  { provider: 'claude', label: 'Claude' },
]

export const ChatInput = memo(function ChatInput({
  value,
  onChangeText,
  onSubmit,
  onStop,
  onPickImages,
  onPasteImage,
  onTakePhoto,
  onRemoveAttachment,
  disabled,
  sendDisabled = false,
  sendDisabledReason,
  placeholder = 'Ask anything',
  attachments,
  skills,
  loadSkills,
  models,
  selectedModel,
  selectedEffort,
  effortOptions,
  selectedProvider,
  providers,
  showProviderSelector,
  onSelectModel,
  onSelectEffort,
  onSelectProvider,
  handoffProviders = [],
  onHandoffProviderSelect,
  handoffDisabledReason = null,
  selectedServiceTier = null,
  onSelectServiceTier,
  isRunning = false,
  isStopping = false,
  modelsLoading = false,
  capabilities = NO_AGENT_CAPABILITIES,
  compactCommandAvailable = false,
  selectedPermissionMode = null,
  selectedSandboxMode = null,
  onSelectPermissionMode,
  onSelectSandboxMode,
  onGoalCommand,
  textInputRef,
}: ChatInputProps) {
  const { theme } = useUnistyles()
  const { height: windowHeight } = useWindowDimensions()
  const maxInputHeight = Math.max(
    MIN_INPUT_HEIGHT,
    Math.min(
      MAX_INPUT_HEIGHT,
      Math.round(windowHeight * MAX_INPUT_HEIGHT_WINDOW_FRACTION),
    ),
  )
  const [caretIndex, setCaretIndex] = useState(value.length)
  // An edit we handed to the host: where to put the caret once it echoes the
  // value back, and whether to send it. Keyed by that value so it lands on the
  // render that actually carries the text, and consumed on the first value
  // change either way — a `selection` prop left standing re-pins the caret on
  // every later keystroke, which is what made a transcribed draft impossible
  // to edit, and a send left armed would fire on some unrelated later draft.
  const pendingEditRef = useRef<{
    from: string
    value: string
    start: number
    end: number
    submit: boolean
  } | null>(null)
  const [slashQuery, setSlashQuery] = useState<ActiveSlashQuery | null>(null)
  const [liveSkills, setLiveSkills] = useState<SkillSummary[] | null>(null)
  const loadSkillsRef = useRef(loadSkills)
  loadSkillsRef.current = loadSkills
  const [voiceProvider, setVoiceProvider] = useState<SpeechProvider | null>(
    null,
  )
  const [openSheet, setOpenSheet] = useState<
    'more' | 'permission' | 'sandbox' | 'voice-provider' | null
  >(null)
  const selectionRangeRef = useRef({ start: value.length, end: value.length })
  const inputRef = useRef<TextInput | null>(null)
  const attachInput = useCallback(
    (node: TextInput | null) => {
      inputRef.current = node
      if (textInputRef) textInputRef.current = node
    },
    [textInputRef],
  )
  const hasContent = value.trim().length > 0 || attachments.length > 0
  // Stop-generating only takes the primary slot while there is nothing to
  // send; the mic keeps its own slot beside it so dictation can extend a
  // draft instead of being the thing an empty composer does instead of Send.
  const showStop = Boolean(onStop) && isRunning && !hasContent

  const slashOpen = slashQuery !== null
  useEffect(() => {
    if (!slashOpen) return
    const load = loadSkillsRef.current
    if (!load) {
      setLiveSkills(null)
      return
    }
    let cancelled = false
    void load(selectedProvider).then(
      (next) => {
        if (!cancelled) setLiveSkills(next)
      },
      () => {
        if (!cancelled) setLiveSkills(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [selectedProvider, slashOpen])

  const filteredSkills = useMemo(
    () =>
      filterSlashSkills(
        liveSkills ?? skills,
        selectedProvider,
        slashQuery?.query ?? '',
      ),
    [liveSkills, selectedProvider, skills, slashQuery?.query],
  )
  const showGoalCommand =
    Boolean(onGoalCommand) &&
    capabilities.supports_goals &&
    'goal'.includes(slashQuery?.query.trim().toLowerCase() ?? '')
  const showCompactCommand =
    compactCommandAvailable &&
    'compact'.includes(slashQuery?.query.trim().toLowerCase() ?? '')

  const updateSlashQuery = useCallback(
    (nextValue: string, caretIndex: number) => {
      if (disabled) {
        setSlashQuery(null)
        return
      }

      setSlashQuery(activeSlashQuery(nextValue, caretIndex))
    },
    [disabled],
  )

  useEffect(() => {
    const boundedCaretIndex = Math.min(caretIndex, value.length)
    const boundedSelectionStart = Math.min(
      selectionRangeRef.current.start,
      value.length,
    )
    const boundedSelectionEnd = Math.min(
      selectionRangeRef.current.end,
      value.length,
    )

    if (
      boundedSelectionStart !== selectionRangeRef.current.start ||
      boundedSelectionEnd !== selectionRangeRef.current.end
    ) {
      selectionRangeRef.current = {
        start: boundedSelectionStart,
        end: boundedSelectionEnd,
      }
    }

    if (boundedCaretIndex !== caretIndex) {
      setCaretIndex(boundedCaretIndex)
      return
    }

    updateSlashQuery(value, boundedCaretIndex)
  }, [caretIndex, updateSlashQuery, value])

  const handleSubmit = useCallback(() => {
    if ((!value.trim() && attachments.length === 0) || disabled || sendDisabled)
      return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onSubmit()
  }, [attachments.length, value, disabled, onSubmit, sendDisabled])

  useEffect(() => {
    const pending = pendingEditRef.current
    // Still the pre-edit text: the host has not echoed our write yet.
    if (!pending || value === pending.from) return
    pendingEditRef.current = null
    if (pending.value !== value) return
    selectionRangeRef.current = { start: pending.start, end: pending.end }
    setCaretIndex(pending.start)
    inputRef.current?.setSelection?.(pending.start, pending.end)
    if (pending.submit) handleSubmit()
  }, [handleSubmit, value])

  const handleStop = useCallback(() => {
    if (disabled || sendDisabled || isStopping || !onStop) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    onStop()
  }, [disabled, isStopping, onStop, sendDisabled])

  const handleChangeText = useCallback(
    (nextValue: string) => {
      const { start, end } = selectionRangeRef.current
      const selectedLength = Math.max(0, end - start)
      const insertedLength = nextValue.length - (value.length - selectedLength)
      const nextCaret = Math.max(
        0,
        Math.min(start + insertedLength, nextValue.length),
      )

      selectionRangeRef.current = { start: nextCaret, end: nextCaret }
      setCaretIndex(nextCaret)
      onChangeText(nextValue)
    },
    [onChangeText, value.length],
  )

  const handleMicPress = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    // The input is only hidden while recording, not unmounted, so an open
    // keyboard would stay up over the waveform until the transcript lands.
    inputRef.current?.blur()
    // A saved recording knows its provider; otherwise reuse the configured
    // one and only ask on true first use.
    const provider =
      getSpeechSettings().provider ?? getPendingVoiceRecording()?.provider
    if (provider) {
      setVoiceProvider(provider)
    } else {
      setOpenSheet('voice-provider')
    }
  }, [])

  const handleVoiceTranscript = useCallback(
    (transcript: string, options?: { submit?: boolean }) => {
      const { value: nextValue, caret } = insertTranscript(
        value,
        transcript,
        selectionRangeRef.current,
      )
      if (nextValue === value) return
      // The effect above fires the send once the host has echoed the dictated
      // text back as `value`; submitting here would race the host's state.
      pendingEditRef.current = {
        from: value,
        value: nextValue,
        start: caret,
        end: caret,
        submit: options?.submit === true,
      }
      onChangeText(nextValue)
      if (!options?.submit) inputRef.current?.focus()
    },
    [onChangeText, value],
  )

  const handleInsertSkill = useCallback(
    (alias: string) => {
      if (!slashQuery) return
      triggerComposerSelectionHaptic()

      const nextValue = `${value.slice(0, slashQuery.rangeStart)}${alias} ${value.slice(slashQuery.rangeEnd)}`
      const nextCaret = slashQuery.rangeStart + alias.length + 1

      pendingEditRef.current = {
        from: value,
        value: nextValue,
        start: nextCaret,
        end: nextCaret,
        submit: false,
      }
      onChangeText(nextValue)
      setSlashQuery(null)
    },
    [onChangeText, slashQuery, value],
  )

  const handleGoalCommand = useCallback(() => {
    if (!slashQuery || !onGoalCommand) return
    triggerComposerSelectionHaptic()
    const nextValue = `${value.slice(0, slashQuery.rangeStart)}${value.slice(slashQuery.rangeEnd)}`
    const nextCaret = slashQuery.rangeStart
    pendingEditRef.current = {
      from: value,
      value: nextValue,
      start: nextCaret,
      end: nextCaret,
      submit: false,
    }
    onChangeText(nextValue)
    setSlashQuery(null)
    onGoalCommand()
  }, [onChangeText, onGoalCommand, slashQuery, value])

  const canSend = hasContent && !disabled && !sendDisabled
  const canStop = showStop && !disabled && !sendDisabled && !isStopping
  const canUsePrimary = showStop ? canStop : canSend
  const providerOptions = providers ?? DEFAULT_PROVIDER_OPTIONS
  const moreItems = useMemo<OptionSheetItem[]>(() => {
    const items: OptionSheetItem[] = []
    if (capabilities.supports_images) {
      if (onPasteImage) {
        items.push({
          value: 'paste-image',
          label: 'Paste image',
          description: 'Attach an image copied to your clipboard',
        })
      }
      items.push({
        value: 'photos',
        label: 'Photos',
        description: 'Choose images from your photo library',
      })
      if (onTakePhoto) {
        items.push({
          value: 'camera',
          label: 'Camera',
          description: 'Take a new photo',
        })
      }
    }
    if (onSelectPermissionMode && capabilities.permission_modes.length > 0) {
      items.push({
        value: 'permission',
        label: 'Permissions',
        description: permissionChipLabel(
          selectedPermissionMode,
          capabilities.permission_modes,
        ),
      })
    }
    if (onSelectSandboxMode && capabilities.sandbox_modes.length > 0) {
      items.push({
        value: 'sandbox',
        label: 'Sandbox',
        description: sandboxChipLabel(selectedSandboxMode),
      })
    }
    return items
  }, [
    capabilities.permission_modes,
    capabilities.sandbox_modes,
    capabilities.supports_images,
    onSelectPermissionMode,
    onSelectSandboxMode,
    onPasteImage,
    onTakePhoto,
    selectedPermissionMode,
    selectedSandboxMode,
  ])

  const handleMoreAction = useCallback(
    (value: string) => {
      if (value === 'photos') {
        setOpenSheet(null)
        onPickImages()
      } else if (value === 'paste-image') {
        setOpenSheet(null)
        onPasteImage?.()
      } else if (value === 'camera') {
        setOpenSheet(null)
        onTakePhoto?.()
      } else if (value === 'permission') {
        setOpenSheet('permission')
      } else if (value === 'sandbox') {
        setOpenSheet('sandbox')
      }
    },
    [onPasteImage, onPickImages, onTakePhoto],
  )

  return (
    <View style={styles.container}>
      <GlassSurface
        radius={theme.radius['2xl']}
        intensity={70}
        highlight={false}
        contentStyle={styles.composer}
      >
        {attachments.length > 0 ? (
          <View style={styles.attachmentSection}>
            <AttachmentPreviewList
              attachments={attachments}
              onRemoveAttachment={onRemoveAttachment}
              disabled={disabled}
            />
          </View>
        ) : null}
        {voiceProvider ? (
          <InlineVoiceRecorder
            provider={voiceProvider}
            onTranscript={handleVoiceTranscript}
            onClose={() => setVoiceProvider(null)}
          />
        ) : null}
        <TextInput
          ref={attachInput}
          style={[
            styles.input,
            voiceProvider ? styles.inputHidden : null,
            { maxHeight: maxInputHeight },
          ]}
          value={value}
          onChangeText={handleChangeText}
          onSelectionChange={(event) => {
            const nextSelection = event.nativeEvent.selection
            selectionRangeRef.current = nextSelection
            setCaretIndex(nextSelection.start)
          }}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.fg.muted}
          selectionColor={theme.colors.accent.default}
          multiline
          maxLength={100_000}
          editable={!disabled}
        />
        {slashQuery ? (
          <View style={styles.skillMenu}>
            {filteredSkills.length > 0 || showGoalCommand || showCompactCommand ? (
              <>
                {showGoalCommand ? (
                  <Pressable
                    style={[
                      styles.skillItem,
                      filteredSkills.length === 0 &&
                        !showCompactCommand &&
                        styles.skillItemLast,
                    ]}
                    onPress={handleGoalCommand}
                    accessibilityRole="button"
                    accessibilityLabel="Set a goal"
                  >
                    <Target
                      size={theme.iconSize.sm}
                      color={theme.colors.fg.muted}
                    />
                    <View style={styles.skillItemBody}>
                      <Text color="primary" size="sm" weight="medium">
                        Goal
                      </Text>
                      <Text variant="caption" color="secondary" size="xs">
                        Set a goal to keep pursuing
                      </Text>
                    </View>
                  </Pressable>
                ) : null}
                {showCompactCommand ? (
                  <Pressable
                    style={[
                      styles.skillItem,
                      filteredSkills.length === 0 && styles.skillItemLast,
                    ]}
                    onPress={() => handleInsertSkill('/compact')}
                    accessibilityRole="button"
                    accessibilityLabel="Compact conversation context"
                  >
                    <BookOpen
                      size={theme.iconSize.sm}
                      color={theme.colors.fg.muted}
                    />
                    <View style={styles.skillItemBody}>
                      <View style={styles.skillHeading}>
                        <View style={styles.skillAliasPill}>
                          <Text
                            variant="caption"
                            size="2xs"
                            color="secondary"
                            weight="semibold"
                          >
                            /compact
                          </Text>
                        </View>
                        <Text variant="caption" size="2xs" color="muted">
                          harness
                        </Text>
                      </View>
                      <Text color="primary" size="sm" weight="medium">
                        Compact context
                      </Text>
                      <Text variant="caption" color="secondary" size="xs">
                        Compact conversation history to free context
                      </Text>
                    </View>
                  </Pressable>
                ) : null}
                {filteredSkills.map((skill) => {
                const lastItem =
                  filteredSkills[filteredSkills.length - 1]?.id === skill.id

                return (
                  <Pressable
                    key={skill.id}
                    style={[
                      styles.skillItem,
                      lastItem && styles.skillItemLast,
                    ]}
                    onPress={() => handleInsertSkill(skill.alias)}
                  >
                    <View style={styles.skillItemBody}>
                      <View style={styles.skillHeading}>
                        <View style={styles.skillAliasPill}>
                          <Text
                            variant="caption"
                            size="2xs"
                            color="secondary"
                            weight="semibold"
                          >
                            {skill.alias}
                          </Text>
                        </View>
                        <Text variant="caption" size="2xs" color="muted">
                          {skill.source_kind.replace('_', ' ')}
                        </Text>
                      </View>
                      <Text color="primary" size="sm" weight="medium">
                        {skill.label}
                      </Text>
                      {skill.description ? (
                        <Text variant="caption" color="secondary" size="xs">
                          {skill.description}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                )
                })}
              </>
            ) : (
              <View style={styles.skillEmpty}>
                <Text variant="caption" color="muted">
                  No commands or skills match /{slashQuery.query}
                </Text>
              </View>
            )}
          </View>
        ) : null}
        {hasContent && sendDisabled && sendDisabledReason ? (
          <Text
            variant="caption"
            color="warning"
            size="xs"
            accessibilityLiveRegion="polite"
            style={styles.sendDisabledReason}
          >
            {sendDisabledReason}
          </Text>
        ) : null}
        {voiceProvider ? null : (
        <View style={styles.footer}>
          <View style={styles.footerControls}>
            {moreItems.length > 0 ? (
              <Pressable
                style={[
                  styles.attachButton,
                  disabled ? styles.attachButtonDisabled : null,
                ]}
                onPress={() => {
                  triggerComposerSelectionHaptic()
                  setOpenSheet('more')
                }}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel="Add to prompt"
                accessibilityState={{ disabled: Boolean(disabled) }}
                hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
              >
                <Plus
                  size={theme.iconSize.md}
                  color={
                    disabled ? theme.colors.fg.faint : theme.colors.fg.muted
                  }
                />
              </Pressable>
            ) : null}
            <InputToolbar
              models={models}
              selectedModel={selectedModel}
              selectedEffort={selectedEffort}
              effortOptions={effortOptions}
              selectedProvider={selectedProvider}
              providers={providerOptions}
              showProviderSelector={showProviderSelector}
              disabled={disabled}
              onSelectModel={onSelectModel}
              onSelectEffort={onSelectEffort}
              onSelectProvider={onSelectProvider}
              handoffProviders={handoffProviders}
              onHandoffProviderSelect={onHandoffProviderSelect}
              handoffDisabledReason={handoffDisabledReason}
              selectedServiceTier={selectedServiceTier}
              onSelectServiceTier={onSelectServiceTier}
              capabilities={capabilities}
              selectedPermissionMode={selectedPermissionMode}
              selectedSandboxMode={selectedSandboxMode}
              onSelectPermissionMode={onSelectPermissionMode}
              onSelectSandboxMode={onSelectSandboxMode}
              showModePickers={false}
              modelsLoading={modelsLoading}
            />
          </View>
          <View style={styles.footerActions}>
            <Pressable
              style={[
                styles.sendButton,
                disabled ? styles.micButtonDisabled : null,
              ]}
              onPress={handleMicPress}
              disabled={Boolean(disabled)}
              accessibilityRole="button"
              accessibilityLabel="Record voice message"
              accessibilityHint="Dictates into the composer at the cursor"
              accessibilityState={{ disabled: Boolean(disabled) }}
              hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
            >
              <Mic
                size={theme.iconSize.md}
                color={
                  disabled ? theme.colors.fg.faint : theme.colors.fg.secondary
                }
              />
            </Pressable>
            <Pressable
              style={[
                styles.sendButton,
                canUsePrimary ? styles.sendActive : styles.sendInactive,
              ]}
              onPress={showStop ? handleStop : handleSubmit}
              disabled={!canUsePrimary}
              accessibilityRole="button"
              accessibilityLabel={
                showStop
                  ? isStopping
                    ? 'Stopping'
                    : 'Stop generating'
                  : 'Send message'
              }
              accessibilityHint={sendDisabled ? sendDisabledReason : undefined}
              accessibilityState={{ disabled: !canUsePrimary }}
              hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
            >
              {showStop ? (
                <Square
                  size={theme.iconSize.md - 4}
                  color={
                    canStop ? theme.colors.surface[0] : theme.colors.fg.faint
                  }
                  fill={
                    canStop ? theme.colors.surface[0] : theme.colors.fg.faint
                  }
                />
              ) : (
                <Send
                  size={theme.iconSize.md}
                  color={
                    canSend ? theme.colors.surface[0] : theme.colors.fg.faint
                  }
                />
              )}
            </Pressable>
          </View>
        </View>
        )}
      </GlassSurface>
      {openSheet === 'more' ? (
        <OptionSheet
          title="Add to prompt"
          items={moreItems}
          onSelect={handleMoreAction}
          onClose={() => setOpenSheet(null)}
        />
      ) : null}
      {openSheet === 'permission' && onSelectPermissionMode ? (
        <OptionSheet
          title="Permissions"
          items={permissionModeItems(capabilities.permission_modes)}
          selected={
            selectedPermissionMode ??
            (capabilities.permission_modes.includes('default')
              ? 'default'
              : null)
          }
          onSelect={(value) => {
            onSelectPermissionMode(value)
            setOpenSheet(null)
          }}
          onClose={() => setOpenSheet(null)}
        />
      ) : null}
      {openSheet === 'sandbox' && onSelectSandboxMode ? (
        <OptionSheet
          title="Sandbox"
          items={sandboxModeItems(capabilities.sandbox_modes)}
          selected={selectedSandboxMode ?? SANDBOX_DEFAULT_VALUE}
          onSelect={(value) => {
            onSelectSandboxMode(value === SANDBOX_DEFAULT_VALUE ? null : value)
            setOpenSheet(null)
          }}
          onClose={() => setOpenSheet(null)}
        />
      ) : null}
      {openSheet === 'voice-provider' ? (
        <OptionSheet
          title="Voice input"
          items={[
            {
              value: 'on-device',
              label: 'On-device',
              description:
                'Private and offline when your phone has a downloaded speech model.',
            },
            {
              value: 'openrouter',
              label: 'OpenRouter',
              description:
                'Audio is encrypted to your desktop, which sends it to OpenRouter.',
            },
          ]}
          onSelect={(value) => {
            setOpenSheet(null)
            setVoiceProvider(value as SpeechProvider)
          }}
          onClose={() => setOpenSheet(null)}
        />
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  // No plate behind the composer: it floats on the screen background so the
  // glass panel is the only chrome at the bottom of the thread.
  container: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  composer: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
  },
  input: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * theme.lineHeight.normal,
    fontFamily: theme.fontFamily.sans,
    color: theme.colors.fg.primary,
    // No explicit height: on the new architecture a multiline input sizes
    // itself to its content, growing to maxHeight and scrolling past it.
    // Driving height from onContentSizeChange fought that and left the box
    // stuck at one line with scrolling disabled.
    minHeight: MIN_INPUT_HEIGHT,
    maxHeight: MAX_INPUT_HEIGHT,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 0,
    textAlignVertical: 'top',
  },
  inputHidden: {
    display: 'none',
  },
  attachmentSection: {
    paddingHorizontal: theme.spacing[4],
  },
  skillMenu: {
    marginHorizontal: theme.spacing[3],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: glassEdge(theme.isDark),
    backgroundColor: glassFill(theme.isDark),
    overflow: 'hidden',
  },
  skillItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: glassEdge(theme.isDark),
  },
  skillItemLast: {
    borderBottomWidth: 0,
  },
  skillItemBody: {
    gap: theme.spacing[1],
  },
  skillHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[2],
  },
  skillAliasPill: {
    borderRadius: theme.radius.full,
    backgroundColor: glassFill(theme.isDark),
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  skillEmpty: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  sendDisabledReason: {
    paddingHorizontal: theme.spacing[4],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // A chip row longer than the space scrolls, and its clipped edge landed
    // flush against the send button — which read as a chip jammed underneath
    // rather than as more chips to scroll to.
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  footerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
  },
  micButtonDisabled: {
    opacity: 0.6,
  },
  footerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    flexShrink: 1,
    gap: theme.spacing[2],
  },
  attachButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: glassFill(theme.isDark),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: glassEdge(theme.isDark),
  },
  attachButtonDisabled: {
    opacity: 0.6,
  },
  sendButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendActive: {
    backgroundColor: theme.colors.accent.default,
  },
  sendInactive: {
    backgroundColor: glassFill(theme.isDark),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: glassEdge(theme.isDark),
  },
}))
