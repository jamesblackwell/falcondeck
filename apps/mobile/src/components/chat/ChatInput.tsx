import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { View, TextInput, Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Mic, Plus, Send, Square, Target } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import {
  activeSlashQuery,
  canonicalSkillAlias,
  NO_AGENT_CAPABILITIES,
  providerSupportsSkill,
  type ActiveSlashQuery,
  type AgentCapabilitySummary,
  type AgentProvider,
  type ImageInput,
  type ModelSummary,
  type ProviderOption,
  type SkillSummary,
} from '@falcondeck/client-core'

import { OptionSheet, Text, type OptionSheetItem } from '@/components/ui'

import {
  getPendingVoiceRecording,
  getSpeechSettings,
  type SpeechProvider,
} from '@/features/speech/speechSettings'

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
  /** Tier id while fast mode is on; null is the provider's standard tier. */
  selectedServiceTier?: string | null
  onSelectServiceTier?: (tier: string | null) => void
  /** True while the selected thread has an in-flight turn. */
  isRunning?: boolean
  /** True while an interrupt request is in flight. */
  isStopping?: boolean
  capabilities?: AgentCapabilitySummary
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
  selectedServiceTier = null,
  onSelectServiceTier,
  isRunning = false,
  isStopping = false,
  capabilities = NO_AGENT_CAPABILITIES,
  selectedPermissionMode = null,
  selectedSandboxMode = null,
  onSelectPermissionMode,
  onSelectSandboxMode,
  onGoalCommand,
  textInputRef,
}: ChatInputProps) {
  const { theme } = useUnistyles()
  const [caretIndex, setCaretIndex] = useState(value.length)
  const [pendingSelection, setPendingSelection] = useState<{
    start: number
    end: number
  } | null>(null)
  const [slashQuery, setSlashQuery] = useState<ActiveSlashQuery | null>(null)
  const [voiceProvider, setVoiceProvider] = useState<SpeechProvider | null>(
    null,
  )
  const [openSheet, setOpenSheet] = useState<
    'more' | 'provider' | 'permission' | 'sandbox' | 'voice-provider' | null
  >(null)
  const selectionRangeRef = useRef({ start: value.length, end: value.length })
  const hasContent = value.trim().length > 0 || attachments.length > 0
  const showStop = Boolean(onStop) && isRunning && !hasContent
  const showMic = !showStop && !hasContent

  const filteredSkills = useMemo(() => {
    const query = slashQuery?.query.trim().toLowerCase() ?? ''
    const visibleSkills = skills.filter((skill) => {
      if (!query) return true

      return (
        canonicalSkillAlias(skill.alias).includes(`/${query}`) ||
        skill.label.toLowerCase().includes(query) ||
        (skill.description ?? '').toLowerCase().includes(query)
      )
    })

    return visibleSkills.sort((left, right) => {
      const leftSupported = providerSupportsSkill(left, selectedProvider)
      const rightSupported = providerSupportsSkill(right, selectedProvider)
      if (leftSupported !== rightSupported) {
        return leftSupported ? -1 : 1
      }

      return left.alias.localeCompare(right.alias)
    })
  }, [selectedProvider, skills, slashQuery?.query])
  const showGoalCommand =
    Boolean(onGoalCommand) &&
    capabilities.supports_goals &&
    'goal'.includes(slashQuery?.query.trim().toLowerCase() ?? '')

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

    if (
      pendingSelection &&
      (pendingSelection.start > value.length ||
        pendingSelection.end > value.length)
    ) {
      setPendingSelection(null)
    }

    updateSlashQuery(value, boundedCaretIndex)
  }, [caretIndex, pendingSelection, updateSlashQuery, value])

  const handleSubmit = useCallback(() => {
    if ((!value.trim() && attachments.length === 0) || disabled || sendDisabled)
      return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onSubmit()
  }, [attachments.length, value, disabled, onSubmit, sendDisabled])

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
    (transcript: string) => {
      const nextCaret = transcript.length
      selectionRangeRef.current = { start: nextCaret, end: nextCaret }
      setCaretIndex(nextCaret)
      setPendingSelection({ start: nextCaret, end: nextCaret })
      onChangeText(transcript)
    },
    [onChangeText],
  )

  const handleInsertSkill = useCallback(
    (alias: string) => {
      if (!slashQuery) return

      const nextValue = `${value.slice(0, slashQuery.rangeStart)}${alias} ${value.slice(slashQuery.rangeEnd)}`
      const nextCaret = slashQuery.rangeStart + alias.length + 1

      onChangeText(nextValue)
      selectionRangeRef.current = { start: nextCaret, end: nextCaret }
      setCaretIndex(nextCaret)
      setPendingSelection({ start: nextCaret, end: nextCaret })
      setSlashQuery(null)
    },
    [onChangeText, slashQuery, value],
  )

  const handleGoalCommand = useCallback(() => {
    if (!slashQuery || !onGoalCommand) return
    const nextValue = `${value.slice(0, slashQuery.rangeStart)}${value.slice(slashQuery.rangeEnd)}`
    const nextCaret = slashQuery.rangeStart
    onChangeText(nextValue)
    selectionRangeRef.current = { start: nextCaret, end: nextCaret }
    setCaretIndex(nextCaret)
    setPendingSelection({ start: nextCaret, end: nextCaret })
    setSlashQuery(null)
    onGoalCommand()
  }, [onChangeText, onGoalCommand, slashQuery, value])

  const canSend = hasContent && !disabled && !sendDisabled
  const canStop = showStop && !disabled && !sendDisabled && !isStopping
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
    if (showProviderSelector && providerOptions.length > 0) {
      items.push({
        value: 'provider',
        label: 'Agent',
        description:
          providerOptions.find((option) => option.provider === selectedProvider)
            ?.label ?? selectedProvider,
      })
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
    providerOptions,
    selectedPermissionMode,
    selectedProvider,
    selectedSandboxMode,
    showProviderSelector,
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
      } else if (value === 'provider') {
        setOpenSheet('provider')
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
      <View style={styles.composer}>
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
          ref={textInputRef}
          style={[styles.input, voiceProvider ? styles.inputHidden : null]}
          value={value}
          onChangeText={handleChangeText}
          onSelectionChange={(event) => {
            const nextSelection = event.nativeEvent.selection
            selectionRangeRef.current = nextSelection
            setCaretIndex(nextSelection.start)
            if (
              pendingSelection &&
              nextSelection.start === pendingSelection.start &&
              nextSelection.end === pendingSelection.end
            ) {
              setPendingSelection(null)
            }
          }}
          selection={pendingSelection ?? undefined}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.fg.muted}
          selectionColor={theme.colors.accent.default}
          multiline
          maxLength={100_000}
          editable={!disabled}
        />
        {slashQuery ? (
          <View style={styles.skillMenu}>
            {filteredSkills.length > 0 || showGoalCommand ? (
              <>
                {showGoalCommand ? (
                  <Pressable
                    style={[
                      styles.skillItem,
                      filteredSkills.length === 0 && styles.skillItemLast,
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
                {filteredSkills.map((skill) => {
                const supported = providerSupportsSkill(skill, selectedProvider)
                const lastItem =
                  filteredSkills[filteredSkills.length - 1]?.id === skill.id

                return (
                  <Pressable
                    key={skill.id}
                    style={[
                      styles.skillItem,
                      lastItem && styles.skillItemLast,
                      !supported && styles.skillItemDisabled,
                    ]}
                    onPress={() => handleInsertSkill(skill.alias)}
                    disabled={!supported}
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
                          {skill.providers.join(' / ')}
                        </Text>
                      </View>
                      <Text
                        color={supported ? 'primary' : 'muted'}
                        size="sm"
                        weight="medium"
                      >
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
                  No skills match /{slashQuery.query}
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
                onPress={() => setOpenSheet('more')}
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
              providers={providers}
              showProviderSelector={false}
              disabled={disabled}
              onSelectModel={onSelectModel}
              onSelectEffort={onSelectEffort}
              onSelectProvider={onSelectProvider}
              selectedServiceTier={selectedServiceTier}
              onSelectServiceTier={onSelectServiceTier}
              capabilities={capabilities}
              selectedPermissionMode={selectedPermissionMode}
              selectedSandboxMode={selectedSandboxMode}
              onSelectPermissionMode={onSelectPermissionMode}
              onSelectSandboxMode={onSelectSandboxMode}
              showModePickers={false}
            />
          </View>
          <Pressable
            style={[
              styles.sendButton,
              showStop
                ? canStop
                  ? styles.sendActive
                  : styles.sendInactive
                : showMic
                  ? disabled
                    ? styles.sendInactive
                    : styles.sendActive
                  : canSend
                  ? styles.sendActive
                  : styles.sendInactive,
            ]}
            onPress={
              showStop ? handleStop : showMic ? handleMicPress : handleSubmit
            }
            disabled={showStop ? !canStop : showMic ? Boolean(disabled) : !canSend}
            accessibilityRole="button"
            accessibilityLabel={
              showStop
                ? isStopping
                  ? 'Stopping'
                  : 'Stop generating'
                : showMic
                  ? 'Record voice message'
                  : 'Send message'
            }
            accessibilityHint={
              showMic ? 'Starts voice recording in the composer' : sendDisabled ? sendDisabledReason : undefined
            }
            accessibilityState={{
              disabled: showStop ? !canStop : showMic ? Boolean(disabled) : !canSend,
            }}
            hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
          >
            {showStop ? (
              <Square
                size={theme.iconSize.md - 4}
                color={
                  canStop ? theme.colors.surface[0] : theme.colors.fg.faint
                }
                fill={canStop ? theme.colors.surface[0] : theme.colors.fg.faint}
              />
            ) : showMic ? (
              <Mic
                size={theme.iconSize.md}
                color={disabled ? theme.colors.fg.faint : theme.colors.surface[0]}
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
        )}
      </View>
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
      {openSheet === 'provider' ? (
        <OptionSheet
          title="Agent"
          items={providerOptions.map((option) => ({
            value: option.provider,
            label: option.label,
          }))}
          selected={selectedProvider}
          onSelect={(value) => {
            onSelectProvider(value as AgentProvider)
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
  container: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  composer: {
    backgroundColor: theme.colors.surface[2],
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    overflow: 'hidden',
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
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface[1],
    overflow: 'hidden',
  },
  skillItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  skillItemDisabled: {
    opacity: 0.6,
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
    backgroundColor: theme.colors.surface[3],
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
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
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
    backgroundColor: theme.colors.surface[3],
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
    backgroundColor: theme.colors.surface[3],
  },
}))
