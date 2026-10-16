import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import {
  View,
  TextInput,
  Pressable,
  Modal,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import {
  ArrowUp,
  BookOpen,
  Box,
  Camera,
  ChevronUp,
  ClipboardPaste,
  Images,
  Mic,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Target,
} from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'

import {
  activeSlashQuery,
  insertTranscript,
  NO_AGENT_CAPABILITIES,
  rankSlashSuggestions,
  savedPromptInsertion,
  slashSkillSourceLabel,
  type ActiveSlashQuery,
  type AgentCapabilitySummary,
  type CollaborationModeSummary,
  type ThreadIsolation,
  type AgentProvider,
  type ImageInput,
  type ModelSummary,
  type ProviderOption,
  type RankedSlashItem,
  type SavedPrompt,
  type SkillSummary,
} from '@falcondeck/client-core'

import {
  GlassButton,
  GlassSurface,
  glassFill,
  glassFillStrong,
  OptionSheet,
  SymbolIcon,
  Text,
  type OptionSheetItem,
} from '@/components/ui'

import {
  getPendingVoiceRecording,
  getSpeechSettings,
  type SpeechProvider,
} from '@/features/speech/speechSettings'
import { warmMicrophonePermission } from '@/features/speech/microphonePermission'
import { triggerComposerSelectionHaptic } from '@/lib/haptics'

import { AttachmentPreviewList } from './AttachmentPreviewList'
import { InputToolbar } from './InputToolbar'
import { InlineVoiceRecorder } from './InlineVoiceRecorder'
import {
  collaborationModeItems,
  collaborationModeLabel,
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
  /** Progress of a background action on this thread, such as a handoff copying its transcript. */
  statusNotice?: string
  placeholder?: string
  attachments: ImageInput[]
  skills: SkillSummary[]
  loadSkills?: (provider: AgentProvider) => Promise<SkillSummary[]>
  prompts?: SavedPrompt[]
  loadPrompts?: () => Promise<SavedPrompt[]>
  models: ModelSummary[]
  selectedModel: string | null
  selectedEffort: string | null
  effortOptions: string[]
  selectedProvider: AgentProvider
  providers?: ProviderOption[]
  selectedIsolation?: ThreadIsolation
  onSelectIsolation?: (isolation: ThreadIsolation) => void
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
  collaborationModes?: CollaborationModeSummary[]
  selectedCollaborationMode?: string | null
  onSelectCollaborationMode?: (mode: string) => void
  selectedSandboxMode?: string | null
  onSelectPermissionMode?: (mode: string | null) => void
  onSelectSandboxMode?: (mode: string | null) => void
  /** Opens the provider goal surface after consuming an active /goal query. */
  onGoalCommand?: () => void
  /** Lets the host focus the input imperatively, e.g. on a new conversation. */
  textInputRef?: RefObject<TextInput | null>
}

const MIN_INPUT_HEIGHT = 44
const MAX_INPUT_HEIGHT = 320
// A tall draft (plus attachment previews and the footer) can grow the card
// past the space left above the keyboard; once the message list has shrunk
// to nothing the overflow — the send button — slides under the keyboard.
// Cap growth to a fraction of the window so the composer always fits.
const MAX_INPUT_HEIGHT_WINDOW_FRACTION = 0.48
const COMPOSER_COLLAPSE_MS = 180
const COMPOSER_COLLAPSE_TIMING = {
  duration: COMPOSER_COLLAPSE_MS,
  easing: Easing.out(Easing.cubic),
} as const

/**
 * Empty multiline inputs on the new architecture can report a huge intrinsic
 * height for a beat after the draft is cleared. Pin the collapsed size, and
 * ease down from the last measured draft height so a send cannot balloon.
 */
/* Reanimated SharedValues are mutable native animation handles. */
/* eslint-disable react-hooks/immutability */
function useEmptyComposerCollapse(isEmpty: boolean) {
  const lastHeight = useSharedValue(MIN_INPUT_HEIGHT)
  const collapseHeight = useSharedValue(MIN_INPUT_HEIGHT)
  const collapsing = useSharedValue(false)
  const reducedMotion = useReducedMotion()
  const wasEmptyRef = useRef(isEmpty)

  const onInputLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (isEmpty) return
      lastHeight.value = event.nativeEvent.layout.height
    },
    [isEmpty, lastHeight],
  )

  const prepareCollapse = useCallback(() => {
    const from = Math.max(lastHeight.value, MIN_INPUT_HEIGHT)
    if (reducedMotion || from <= MIN_INPUT_HEIGHT + 1) return
    collapseHeight.value = from
    collapsing.value = true
  }, [collapseHeight, collapsing, lastHeight, reducedMotion])

  useLayoutEffect(() => {
    const becameEmpty = isEmpty && !wasEmptyRef.current
    wasEmptyRef.current = isEmpty
    if (!isEmpty) {
      cancelAnimation(collapseHeight)
      collapsing.value = false
      return
    }
    if (!becameEmpty) {
      if (!collapsing.value) collapseHeight.value = MIN_INPUT_HEIGHT
      return
    }
    if (collapsing.value) {
      collapseHeight.value = withTiming(MIN_INPUT_HEIGHT, COMPOSER_COLLAPSE_TIMING)
      return
    }
    const from = Math.max(lastHeight.value, MIN_INPUT_HEIGHT)
    if (reducedMotion || from <= MIN_INPUT_HEIGHT + 1) {
      collapsing.value = false
      collapseHeight.value = MIN_INPUT_HEIGHT
      return
    }
    collapseHeight.value = from
    collapsing.value = true
    collapseHeight.value = withTiming(MIN_INPUT_HEIGHT, COMPOSER_COLLAPSE_TIMING)
  }, [collapseHeight, collapsing, isEmpty, lastHeight, reducedMotion])

  const slotStyle = useAnimatedStyle(() =>
    isEmpty && collapsing.value
      ? {
          height: collapseHeight.value,
          overflow: 'hidden' as const,
        }
      // Reanimated retains native values when a style is removed or omits
      // a property. Explicitly release the slot when drafting resumes.
      : { height: undefined, overflow: undefined },
  )

  return { onInputLayout, prepareCollapse, slotStyle }
}
/* eslint-enable react-hooks/immutability */

// Painted size of the attach/send buttons; hitSlop lifts them to 44pt.
const CONTROL_SIZE = 36
/** The composer card's corner: a capsule at one line, a soft card when tall. */
const COMPOSER_RADIUS = 26
const DEFAULT_PROVIDER_OPTIONS: ProviderOption[] = [
  { provider: 'codex', label: 'Codex' },
  { provider: 'claude', label: 'Claude' },
]
const NO_PROMPTS: SavedPrompt[] = []

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
  statusNotice,
  placeholder = 'Ask anything',
  attachments,
  skills,
  loadSkills,
  prompts = NO_PROMPTS,
  loadPrompts,
  models,
  selectedModel,
  selectedEffort,
  effortOptions,
  selectedProvider,
  providers,
  selectedIsolation = 'project_folder',
  onSelectIsolation,
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
  collaborationModes = [],
  selectedCollaborationMode = null,
  onSelectCollaborationMode,
  selectedSandboxMode = null,
  onSelectPermissionMode,
  onSelectSandboxMode,
  onGoalCommand,
  textInputRef,
}: ChatInputProps) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const { height: windowHeight } = useWindowDimensions()
  const [isExpanded, setIsExpanded] = useState(false)
  const maxInputHeight = Math.max(
    MIN_INPUT_HEIGHT,
    Math.min(
      MAX_INPUT_HEIGHT,
      Math.round(windowHeight * MAX_INPUT_HEIGHT_WINDOW_FRACTION) -
        (attachments.length > 0 ? 80 : 0),
    ),
  )
  const [inputContentHeight, setInputContentHeight] = useState(0)
  const draftIsEmpty = value.length === 0
  const inputOverflows = !draftIsEmpty && inputContentHeight > maxInputHeight + 1
  useEffect(() => {
    if (draftIsEmpty) setIsExpanded(false)
  }, [draftIsEmpty])
  const { onInputLayout, prepareCollapse, slotStyle } =
    useEmptyComposerCollapse(draftIsEmpty)
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
  const [livePrompts, setLivePrompts] = useState<SavedPrompt[] | null>(null)
  const loadSkillsRef = useRef(loadSkills)
  const loadPromptsRef = useRef(loadPrompts)
  useEffect(() => {
    loadSkillsRef.current = loadSkills
  }, [loadSkills])
  useEffect(() => {
    loadPromptsRef.current = loadPrompts
  }, [loadPrompts])
  const [voiceProvider, setVoiceProvider] = useState<SpeechProvider | null>(
    null,
  )
  const [openSheet, setOpenSheet] = useState<
    'more' | 'mode' | 'permission' | 'sandbox' | 'voice-provider' | null
  >(null)
  const selectionRangeRef = useRef({ start: value.length, end: value.length })
  const inputRef = useRef<TextInput | null>(null)
  const expandedInputRef = useRef<TextInput | null>(null)
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

  useEffect(() => {
    void warmMicrophonePermission()
  }, [])

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

  useEffect(() => {
    if (!slashOpen) return
    const load = loadPromptsRef.current
    if (!load) {
      setLivePrompts(null)
      return
    }
    let cancelled = false
    void load().then(
      (next) => {
        if (!cancelled) setLivePrompts(next)
      },
      () => {
        if (!cancelled) setLivePrompts(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [slashOpen])

  const promptAliases = useMemo(
    () => (livePrompts ?? prompts).map((prompt) => prompt.alias),
    [livePrompts, prompts],
  )
  const slashItems = useMemo(
    () =>
      rankSlashSuggestions({
        skills: liveSkills ?? skills,
        prompts: livePrompts ?? prompts,
        provider: selectedProvider,
        query: slashQuery?.query ?? '',
        native: {
          goal: Boolean(onGoalCommand) && capabilities.supports_goals,
          compact: compactCommandAvailable,
        },
      }),
    [
      capabilities.supports_goals,
      compactCommandAvailable,
      livePrompts,
      liveSkills,
      prompts,
      onGoalCommand,
      selectedProvider,
      skills,
      slashQuery?.query,
    ],
  )

  const updateSlashQuery = useCallback(
    (nextValue: string, caretIndex: number) => {
      if (disabled) {
        setSlashQuery(null)
        return
      }

      setSlashQuery(activeSlashQuery(nextValue, caretIndex, promptAliases))
    },
    [disabled, promptAliases],
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
    prepareCollapse()
    onSubmit()
  }, [
    attachments.length,
    value,
    disabled,
    onSubmit,
    prepareCollapse,
    sendDisabled,
  ])

  useEffect(() => {
    const pending = pendingEditRef.current
    // Still the pre-edit text: the host has not echoed our write yet.
    if (!pending || value === pending.from) return
    pendingEditRef.current = null
    if (pending.value !== value) return
    selectionRangeRef.current = { start: pending.start, end: pending.end }
    setCaretIndex(pending.start)
    const editor = isExpanded ? expandedInputRef.current : inputRef.current
    editor?.setSelection?.(pending.start, pending.end)
    if (pending.submit) handleSubmit()
  }, [handleSubmit, isExpanded, value])

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

  const handleMicPressIn = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
  }, [])

  const handleMicPress = useCallback(() => {
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

  const handleInsertPrompt = useCallback(
    (body: string) => {
      if (!slashQuery) return
      triggerComposerSelectionHaptic()
      const next = savedPromptInsertion(value, slashQuery, body)
      pendingEditRef.current = {
        from: value,
        value: next.value,
        start: next.caret,
        end: next.caret,
        submit: false,
      }
      onChangeText(next.value)
      setSlashQuery(null)
    },
    [onChangeText, slashQuery, value],
  )

  const handleInsertSkill = useCallback(
    (alias: string) => {
      if (!slashQuery) return
      triggerComposerSelectionHaptic()

      const rest = value.slice(slashQuery.rangeEnd)
      const insertion = /^\s/.test(rest) ? alias : `${alias} `
      const nextValue = `${value.slice(0, slashQuery.rangeStart)}${insertion}${rest}`
      const nextCaret =
        slashQuery.rangeStart + insertion.length + (rest.startsWith(' ') ? 1 : 0)

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

  const handleSlashItem = useCallback(
    (item: RankedSlashItem) => {
      if (item.kind === 'prompt') {
        handleInsertPrompt(item.prompt.body)
        return
      }
      if (item.kind === 'skill') {
        handleInsertSkill(item.skill.alias)
        return
      }
      if (item.command.id === 'goal') {
        handleGoalCommand()
        return
      }
      if (item.command.id === 'compact') {
        handleInsertSkill(item.command.alias)
      }
    },
    [handleGoalCommand, handleInsertPrompt, handleInsertSkill],
  )

  const canSend = hasContent && !disabled && !sendDisabled
  const canStop = showStop && !disabled && !sendDisabled && !isStopping
  const canUsePrimary = showStop ? canStop : canSend
  const providerOptions = providers ?? DEFAULT_PROVIDER_OPTIONS
  const moreItems = useMemo<OptionSheetItem[]>(() => {
    const items: OptionSheetItem[] = []
    if (onSelectCollaborationMode && collaborationModes.length > 0) {
      items.push({
        value: 'mode',
        label: 'Mode',
        icon: { name: 'slider.horizontal.3', fallback: SlidersHorizontal },
        description: collaborationModeLabel(selectedCollaborationMode, collaborationModes),
      })
    }
    if (capabilities.supports_images) {
      if (onPasteImage) {
        items.push({
          value: 'paste-image',
          label: 'Paste image',
          icon: { name: 'doc.on.clipboard', fallback: ClipboardPaste },
          description: 'Attach an image copied to your clipboard',
        })
      }
      items.push({
        value: 'photos',
        label: 'Photos',
        icon: { name: 'photo.on.rectangle', fallback: Images },
        description: 'Choose images from your photo library',
      })
      if (onTakePhoto) {
        items.push({
          value: 'camera',
          label: 'Camera',
          icon: { name: 'camera', fallback: Camera },
          description: 'Take a new photo',
        })
      }
    }
    if (onSelectPermissionMode && capabilities.permission_modes.length > 0) {
      items.push({
        value: 'permission',
        label: 'Permissions',
        icon: { name: 'checkmark.shield', fallback: ShieldCheck },
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
        icon: { name: 'shippingbox', fallback: Box },
        description: sandboxChipLabel(selectedSandboxMode),
      })
    }
    return items
  }, [
    collaborationModes,
    onSelectCollaborationMode,
    selectedCollaborationMode,
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
      } else if (value === 'mode') {
        setOpenSheet('mode')
      } else if (value === 'sandbox') {
        setOpenSheet('sandbox')
      }
    },
    [onPasteImage, onPickImages, onTakePhoto],
  )

  return (
    <View style={styles.container}>
      <GlassSurface
        radius={COMPOSER_RADIUS}
        intensity={70}
        highlight={false}
        contentStyle={styles.composer}
        testID="composer-card"
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
        <Animated.View
          style={[
            styles.inputSlot,
            slotStyle,
            voiceProvider ? styles.inputHidden : null,
          ]}
        >
          <TextInput
            testID="message-composer"
            accessibilityLabel="Message"
            ref={attachInput}
            style={[
              styles.input,
              voiceProvider ? styles.inputHidden : null,
              { maxHeight: maxInputHeight },
              draftIsEmpty ? styles.inputCollapsed : null,
            ]}
            value={value}
            onChangeText={handleChangeText}
            onLayout={onInputLayout}
            onContentSizeChange={(event) => {
              setInputContentHeight(event.nativeEvent.contentSize.height)
            }}
            accessibilityHint={inputOverflows ? 'Scroll to review your full message' : undefined}
            onSelectionChange={(event) => {
              // The expanded editor is a second controlled input. Its value
              // updates make this hidden field report a selection, which would
              // move the caret used for slash commands and inserts.
              if (isExpanded) return
              const nextSelection = event.nativeEvent.selection
              selectionRangeRef.current = nextSelection
              setCaretIndex(nextSelection.start)
            }}
            placeholder={placeholder}
            placeholderTextColor={theme.colors.fg.muted}
            selectionColor={theme.colors.accent.default}
            keyboardAppearance={theme.isDark ? 'dark' : 'light'}
            multiline
            maxLength={100_000}
            editable={!disabled}
          />
        </Animated.View>
        {inputOverflows && !voiceProvider ? (
          <View style={styles.scrollHint}>
            <Text variant="caption" size="xs" color="muted">
              Scroll to review message
            </Text>
            <Pressable
              style={styles.expandButton}
              onPress={() => setIsExpanded(true)}
              accessibilityRole="button"
              accessibilityLabel="Expand prompt"
              accessibilityHint="Opens a larger editor for this draft"
              hitSlop={6}
            >
              <Text variant="caption" size="xs" color="secondary" weight="medium">
                Expand
              </Text>
              <SymbolIcon
                name="arrow.up.left.and.arrow.down.right"
                fallback={ChevronUp}
                size={theme.iconSize.xs - 2}
                weight="semibold"
                color={theme.colors.fg.secondary}
              />
            </Pressable>
          </View>
        ) : null}
        {slashQuery && !voiceProvider ? (
          <View style={styles.skillMenu}>
            {slashItems.length > 0 ? (
              slashItems.map((item, index) => {
                const lastItem = index === slashItems.length - 1
                if (item.kind === 'native' && item.command.id === 'goal') {
                  return (
                    <Pressable
                      key={item.id}
                      style={({ pressed }) => [
                        styles.skillItem,
                        styles.skillItemRow,
                        lastItem && styles.skillItemLast,
                        pressed && styles.skillItemPressed,
                      ]}
                      onPress={() => handleSlashItem(item)}
                      accessibilityRole="button"
                      accessibilityLabel="Set a goal"
                    >
                      <View style={styles.skillGlyph}>
                        <SymbolIcon
                          name="target"
                          fallback={Target}
                          size={theme.iconSize.sm}
                          color={theme.colors.accent.default}
                        />
                      </View>
                      <View style={styles.skillItemBody}>
                        <Text color="primary" size="sm" weight="medium">
                          Goal
                        </Text>
                        <Text variant="caption" color="secondary" size="xs">
                          {item.command.description}
                        </Text>
                      </View>
                    </Pressable>
                  )
                }
                if (item.kind === 'native' && item.command.id === 'compact') {
                  return (
                    <Pressable
                      key={item.id}
                      style={({ pressed }) => [
                        styles.skillItem,
                        styles.skillItemRow,
                        lastItem && styles.skillItemLast,
                        pressed && styles.skillItemPressed,
                      ]}
                      onPress={() => handleSlashItem(item)}
                      accessibilityRole="button"
                      accessibilityLabel="Compact conversation context"
                    >
                      <View style={styles.skillGlyph}>
                        <SymbolIcon
                          name="rectangle.compress.vertical"
                          fallback={BookOpen}
                          size={theme.iconSize.sm}
                          color={theme.colors.fg.secondary}
                        />
                      </View>
                      <View style={styles.skillItemBody}>
                        <View style={styles.skillHeading}>
                          <Text color="primary" size="sm" weight="medium">
                            Compact context
                          </Text>
                          <View style={styles.skillAliasPill}>
                            <Text
                              variant="caption"
                              size="2xs"
                              color="secondary"
                              weight="semibold"
                            >
                              {item.command.alias}
                            </Text>
                          </View>
                        </View>
                        <Text variant="caption" color="secondary" size="xs">
                          {item.command.description}
                        </Text>
                        <Text variant="caption" size="2xs" color="muted">
                          Harness
                        </Text>
                      </View>
                    </Pressable>
                  )
                }
                if (item.kind !== 'skill' && item.kind !== 'prompt') return null
                const label = item.kind === 'prompt' ? item.prompt.label : item.skill.label
                const alias = item.kind === 'prompt' ? item.prompt.alias : item.skill.alias
                const description =
                  item.kind === 'prompt'
                    ? (item.prompt.description ?? item.prompt.argument_hint)
                    : item.skill.description
                const source =
                  item.kind === 'prompt'
                    ? 'Prompt'
                    : slashSkillSourceLabel(item.skill.source_kind)
                return (
                  <Pressable
                    key={item.id}
                    style={({ pressed }) => [
                      styles.skillItem,
                      lastItem && styles.skillItemLast,
                      pressed && styles.skillItemPressed,
                    ]}
                    onPress={() => handleSlashItem(item)}
                  >
                    <View style={styles.skillItemBody}>
                      <View style={styles.skillHeading}>
                        <Text color="primary" size="sm" weight="medium" style={styles.skillLabel} numberOfLines={1}>
                          {label}
                        </Text>
                        <View style={styles.skillAliasPill}>
                          <Text
                            variant="caption"
                            size="2xs"
                            color="secondary"
                            weight="semibold"
                          >
                            {alias}
                          </Text>
                        </View>
                      </View>
                      {description ? (
                        <Text variant="caption" color="secondary" size="xs" numberOfLines={2}>
                          {description}
                        </Text>
                      ) : null}
                      <Text variant="caption" size="2xs" color="muted">
                        {source}
                      </Text>
                    </View>
                  </Pressable>
                )
              })
            ) : (
              <View style={styles.skillEmpty}>
                <Text variant="caption" color="muted">
                  {slashQuery.query
                    ? `No commands, prompts, or skills match /${slashQuery.query}`
                    : 'No commands, prompts, or skills yet'}
                </Text>
              </View>
            )}
          </View>
        ) : null}
        {statusNotice ? (
          <Text
            variant="caption"
            color="accent"
            size="xs"
            accessibilityLiveRegion="polite"
            style={styles.sendDisabledReason}
          >
            {statusNotice}
          </Text>
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
                style={({ pressed }) => [
                  styles.attachButton,
                  pressed && !disabled ? styles.controlPressed : null,
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
                <SymbolIcon
                  name="plus"
                  fallback={Plus}
                  size={18}
                  weight="medium"
                  color={disabled ? theme.colors.fg.faint : theme.colors.fg.secondary}
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
              selectedIsolation={selectedIsolation}
              onSelectIsolation={onSelectIsolation}
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
              style={({ pressed }) => [
                styles.micButton,
                pressed && !disabled ? styles.controlPressed : null,
                disabled ? styles.micButtonDisabled : null,
              ]}
              onPressIn={handleMicPressIn}
              onPress={handleMicPress}
              disabled={Boolean(disabled)}
              accessibilityRole="button"
              accessibilityLabel="Record voice message"
              accessibilityHint="Dictates into the composer at the cursor"
              accessibilityState={{ disabled: Boolean(disabled) }}
              hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
            >
              <SymbolIcon
                name="mic"
                fallback={Mic}
                size={19}
                color={disabled ? theme.colors.fg.faint : theme.colors.fg.secondary}
              />
            </Pressable>
            <ComposerPrimaryButton
              mode={showStop ? 'stop' : 'send'}
              disabled={!canUsePrimary}
              onPress={showStop ? handleStop : handleSubmit}
              accessibilityLabel={
                showStop
                  ? isStopping
                    ? 'Stopping'
                    : 'Stop generating'
                  : 'Send message'
              }
              accessibilityHint={sendDisabled ? sendDisabledReason : undefined}
            />
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
      {openSheet === 'mode' && onSelectCollaborationMode ? (
        <OptionSheet
          title="Mode"
          items={collaborationModeItems(collaborationModes)}
          selected={selectedCollaborationMode ?? collaborationModes.find((mode) => mode.mode === 'default')?.id ?? collaborationModes[0]?.id ?? null}
          onSelect={(value) => {
            onSelectCollaborationMode(value)
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
      {isExpanded ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setIsExpanded(false)}
          onShow={() => expandedInputRef.current?.focus()}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={[styles.editorScreen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
            accessibilityViewIsModal
          >
            <View style={styles.editorHeader}>
              <View style={styles.editorTitle}>
                <Text variant="label" size="md" weight="semibold">Edit prompt</Text>
                <Text variant="caption" size="xs" color="muted">Draft saved automatically</Text>
              </View>
              <GlassButton
                shape="pill"
                onPress={() => setIsExpanded(false)}
                accessibilityLabel="Done editing prompt"
              >
                <Text variant="label" size="sm" weight="semibold" color="primary">Done</Text>
              </GlassButton>
            </View>
            <TextInput
              ref={expandedInputRef}
              style={styles.editorInput}
              value={value}
              onChangeText={handleChangeText}
              onSelectionChange={(event) => {
                const nextSelection = event.nativeEvent.selection
                selectionRangeRef.current = nextSelection
                setCaretIndex(nextSelection.start)
              }}
              accessibilityLabel="Expanded prompt"
              selectionColor={theme.colors.accent.default}
              keyboardAppearance={theme.isDark ? 'dark' : 'light'}
              placeholder={placeholder}
              placeholderTextColor={theme.colors.fg.muted}
              multiline
              maxLength={100_000}
              editable={!disabled}
              textAlignVertical="top"
            />
            <View style={styles.editorFooter}>
              <Text variant="caption" size="xs" color={sendDisabled ? 'warning' : 'muted'} style={styles.editorStatus}>
                {sendDisabled && sendDisabledReason ? sendDisabledReason : 'Your draft stays in this conversation'}
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.editorSend,
                  canSend ? styles.sendActive : styles.editorSendInactive,
                  pressed && canSend ? styles.sendPressed : null,
                ]}
                onPress={() => {
                  setIsExpanded(false)
                  handleSubmit()
                }}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel="Send prompt"
                accessibilityState={{ disabled: !canSend }}
              >
                <SymbolIcon
                  name="arrow.up"
                  fallback={ArrowUp}
                  size={15}
                  weight="bold"
                  color={canSend ? theme.colors.surface[0] : theme.colors.fg.faint}
                />
                <Text variant="label" size="sm" weight="semibold" style={{ color: canSend ? theme.colors.surface[0] : theme.colors.fg.faint }}>
                  Send
                </Text>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      ) : null}
    </View>
  )
})

interface ComposerPrimaryButtonProps {
  mode: 'send' | 'stop'
  disabled: boolean
  onPress: () => void
  accessibilityLabel: string
  accessibilityHint?: string
}

/**
 * Send, or Stop while a turn runs with nothing drafted. The filled disc
 * grows in as soon as there is something to send, so the button's state
 * reads at a glance without hunting for a greyed-out icon.
 */
const ComposerPrimaryButton = memo(function ComposerPrimaryButton({
  mode,
  disabled,
  onPress,
  accessibilityLabel,
  accessibilityHint,
}: ComposerPrimaryButtonProps) {
  const { theme } = useUnistyles()
  const reducedMotion = useReducedMotion()
  const enabled = !disabled
  const progress = useSharedValue(enabled ? 1 : 0)

  useEffect(() => {
    const target = enabled ? 1 : 0
    progress.value = reducedMotion
      ? target
      : withTiming(target, { duration: 170, easing: Easing.out(Easing.cubic) })
  }, [enabled, progress, reducedMotion])

  const discStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.82 + 0.18 * progress.value }],
  }))

  const discColor = mode === 'stop' ? theme.colors.fg.primary : theme.colors.accent.default
  const iconColor = enabled ? theme.colors.surface[0] : theme.colors.fg.faint

  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !enabled }}
      hitSlop={(theme.minTouchTarget - CONTROL_SIZE) / 2}
      style={({ pressed }) => [styles.sendButton, pressed && enabled ? styles.sendPressed : null]}
      testID="composer-primary"
    >
      <View style={[StyleSheet.absoluteFill, styles.sendInactive]} />
      <Animated.View style={[StyleSheet.absoluteFill, styles.sendDisc, { backgroundColor: discColor }, discStyle]} />
      {mode === 'stop' ? (
        <SymbolIcon name="stop.fill" fallback={Square} size={13} color={iconColor} filled />
      ) : (
        <SymbolIcon name="arrow.up" fallback={ArrowUp} size={17} weight="bold" color={iconColor} />
      )}
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  // No plate behind the composer: the glass card floats over the transcript,
  // which keeps scrolling underneath it.
  container: {
    paddingHorizontal: 10,
    paddingTop: theme.spacing[1],
  },
  composer: {
    paddingTop: theme.spacing[1.5],
  },
  scrollHint: {
    marginHorizontal: theme.spacing[4],
    marginTop: theme.spacing[1],
    paddingTop: theme.spacing[1],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: glassFillStrong(theme.isDark),
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 32,
  },
  expandButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1.5],
    minHeight: 32,
    paddingLeft: theme.spacing[2],
  },
  inputSlot: {
    justifyContent: 'flex-end',
  },
  input: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * theme.lineHeight.normal,
    fontFamily: theme.fontFamily.sans,
    color: theme.colors.fg.primary,
    // No explicit height while drafting: on the new architecture a multiline
    // input sizes itself to its content, growing to maxHeight and scrolling
    // past it. Driving height from onContentSizeChange fought that and left
    // the box stuck at one line with scrolling disabled.
    minHeight: MIN_INPUT_HEIGHT,
    maxHeight: MAX_INPUT_HEIGHT,
    paddingHorizontal: theme.spacing[4] + 2,
    paddingTop: 10,
    paddingBottom: theme.spacing[1],
    textAlignVertical: 'top',
    flexGrow: 0,
  },
  inputCollapsed: {
    height: MIN_INPUT_HEIGHT,
  },
  inputHidden: {
    display: 'none',
  },
  attachmentSection: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1.5],
  },
  skillMenu: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    backgroundColor: glassFill(theme.isDark),
    overflow: 'hidden',
  },
  skillItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: glassFillStrong(theme.isDark),
  },
  skillItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
  },
  skillItemLast: {
    borderBottomWidth: 0,
  },
  skillItemPressed: {
    backgroundColor: glassFill(theme.isDark),
  },
  skillGlyph: {
    width: 30,
    height: 30,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: glassFill(theme.isDark),
  },
  skillItemBody: {
    flex: 1,
    gap: 2,
  },
  skillHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[2],
  },
  skillLabel: {
    flexShrink: 1,
  },
  skillAliasPill: {
    borderRadius: theme.radius.full,
    backgroundColor: glassFill(theme.isDark),
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  skillEmpty: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  sendDisabledReason: {
    paddingHorizontal: theme.spacing[4] + 2,
    paddingBottom: theme.spacing[1],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // A chip row longer than the space scrolls, and its clipped edge landed
    // flush against the send button — which read as a chip jammed underneath
    // rather than as more chips to scroll to.
    gap: theme.spacing[1.5],
    paddingHorizontal: 6,
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1.5],
  },
  footerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  footerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    flexShrink: 1,
    gap: theme.spacing[1.5],
  },
  attachButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: glassFill(theme.isDark),
  },
  attachButtonDisabled: {
    opacity: 0.6,
  },
  micButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButtonDisabled: {
    opacity: 0.6,
  },
  controlPressed: {
    backgroundColor: glassFillStrong(theme.isDark),
  },
  sendButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendPressed: {
    transform: [{ scale: 0.92 }],
  },
  sendDisc: {
    borderRadius: theme.radius.full,
  },
  sendActive: {
    backgroundColor: theme.colors.accent.default,
  },
  sendInactive: {
    borderRadius: theme.radius.full,
    backgroundColor: glassFill(theme.isDark),
  },
  editorScreen: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
  },
  editorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[3],
  },
  editorTitle: {
    flex: 1,
    paddingLeft: theme.spacing[1],
  },
  editorInput: {
    flex: 1,
    minHeight: 0,
    marginHorizontal: theme.spacing[3],
    borderRadius: COMPOSER_RADIUS,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.surface[1],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    paddingHorizontal: theme.spacing[5],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * theme.lineHeight.normal,
    fontFamily: theme.fontFamily.sans,
    color: theme.colors.fg.primary,
  },
  editorFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[5],
    paddingVertical: theme.spacing[3],
  },
  editorStatus: {
    flex: 1,
  },
  editorSend: {
    minHeight: theme.minTouchTarget,
    borderRadius: theme.radius.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[5],
  },
  editorSendInactive: {
    backgroundColor: theme.colors.surface[2],
  },
}))
