import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, TextInput, Pressable, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ImagePlus, Send } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import {
  activeSlashQuery,
  canonicalSkillAlias,
  providerSupportsSkill,
  type ActiveSlashQuery,
  type AgentProvider,
  type ImageInput,
  type ModelSummary,
  type SkillSummary,
} from '@falcondeck/client-core'

import { Text } from '@/components/ui'

import { AttachmentPreviewList } from './AttachmentPreviewList'
import { InputToolbar } from './InputToolbar'

interface ChatInputProps {
  value: string
  onChangeText: (text: string) => void
  onSubmit: () => void
  onPickImages: () => void
  onRemoveAttachment: (attachmentId: string) => void
  disabled?: boolean
  placeholder?: string
  attachments: ImageInput[]
  skills: SkillSummary[]
  models: ModelSummary[]
  selectedModel: string | null
  selectedEffort: string | null
  effortOptions: string[]
  selectedProvider: AgentProvider
  showProviderSelector: boolean
  showPlanModeToggle?: boolean
  planModeEnabled?: boolean
  onSelectModel: (modelId: string | null) => void
  onSelectEffort: (effort: string | null) => void
  onSelectProvider: (provider: AgentProvider) => void
  onTogglePlanMode?: (enabled: boolean) => void
}

const MIN_INPUT_HEIGHT = 44
const MAX_INPUT_HEIGHT = 140

export const ChatInput = memo(function ChatInput({
  value,
  onChangeText,
  onSubmit,
  onPickImages,
  onRemoveAttachment,
  disabled,
  placeholder = 'Ask your agent...',
  attachments,
  skills,
  models,
  selectedModel,
  selectedEffort,
  effortOptions,
  selectedProvider,
  showProviderSelector,
  showPlanModeToggle,
  planModeEnabled,
  onSelectModel,
  onSelectEffort,
  onSelectProvider,
  onTogglePlanMode,
}: ChatInputProps) {
  const { theme } = useUnistyles()
  const [caretIndex, setCaretIndex] = useState(value.length)
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT)
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(null)
  const [slashQuery, setSlashQuery] = useState<ActiveSlashQuery | null>(null)
  const selectionRangeRef = useRef({ start: value.length, end: value.length })

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
    const boundedSelectionStart = Math.min(selectionRangeRef.current.start, value.length)
    const boundedSelectionEnd = Math.min(selectionRangeRef.current.end, value.length)

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
      (pendingSelection.start > value.length || pendingSelection.end > value.length)
    ) {
      setPendingSelection(null)
    }

    updateSlashQuery(value, boundedCaretIndex)
  }, [caretIndex, pendingSelection, updateSlashQuery, value])

  useEffect(() => {
    if (value.length === 0) {
      setInputHeight(MIN_INPUT_HEIGHT)
    }
  }, [value])

  const handleSubmit = useCallback(() => {
    if ((!value.trim() && attachments.length === 0) || disabled) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onSubmit()
  }, [attachments.length, value, disabled, onSubmit])

  const handleChangeText = useCallback(
    (nextValue: string) => {
      const { start, end } = selectionRangeRef.current
      const selectedLength = Math.max(0, end - start)
      const insertedLength = nextValue.length - (value.length - selectedLength)
      const nextCaret = Math.max(0, Math.min(start + insertedLength, nextValue.length))

      selectionRangeRef.current = { start: nextCaret, end: nextCaret }
      setCaretIndex(nextCaret)
      onChangeText(nextValue)
    },
    [onChangeText, value.length],
  )

  const handleInsertSkill = useCallback(
    (alias: string) => {
      if (!slashQuery) return

      const nextValue =
        `${value.slice(0, slashQuery.rangeStart)}${alias} ${value.slice(slashQuery.rangeEnd)}`
      const nextCaret = slashQuery.rangeStart + alias.length + 1

      onChangeText(nextValue)
      selectionRangeRef.current = { start: nextCaret, end: nextCaret }
      setCaretIndex(nextCaret)
      setPendingSelection({ start: nextCaret, end: nextCaret })
      setSlashQuery(null)
    },
    [onChangeText, slashQuery, value],
  )

  const handleContentSizeChange = useCallback(
    (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      const nextHeight = Math.max(
        MIN_INPUT_HEIGHT,
        Math.min(event.nativeEvent.contentSize.height, MAX_INPUT_HEIGHT),
      )
      setInputHeight((current) => (current === nextHeight ? current : nextHeight))
    },
    [],
  )

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled

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
        <TextInput
          style={[styles.input, { height: inputHeight }]}
          value={value}
          onChangeText={handleChangeText}
          onContentSizeChange={handleContentSizeChange}
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
            {filteredSkills.length > 0 ? (
              filteredSkills.map((skill) => {
                const supported = providerSupportsSkill(skill, selectedProvider)
                const lastItem = filteredSkills[filteredSkills.length - 1]?.id === skill.id

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
                          <Text variant="caption" size="2xs" color="secondary" weight="semibold">
                            {skill.alias}
                          </Text>
                        </View>
                        <Text variant="caption" size="2xs" color="muted">
                          {skill.availability}
                        </Text>
                      </View>
                      <Text color={supported ? 'primary' : 'muted'} size="sm" weight="medium">
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
              })
            ) : (
              <View style={styles.skillEmpty}>
                <Text variant="caption" color="muted">
                  No skills match /{slashQuery.query}
                </Text>
              </View>
            )}
          </View>
        ) : null}
        <View style={styles.footer}>
          <View style={styles.footerControls}>
            <Pressable
              style={[styles.attachButton, disabled ? styles.attachButtonDisabled : null]}
              onPress={onPickImages}
              disabled={disabled}
            >
              <ImagePlus size={16} color={disabled ? theme.colors.fg.faint : theme.colors.fg.muted} />
            </Pressable>
            <InputToolbar
              models={models}
              selectedModel={selectedModel}
              selectedEffort={selectedEffort}
              effortOptions={effortOptions}
              selectedProvider={selectedProvider}
              showProviderSelector={showProviderSelector}
              disabled={disabled}
              onSelectModel={onSelectModel}
              onSelectEffort={onSelectEffort}
              onSelectProvider={onSelectProvider}
              showPlanModeToggle={showPlanModeToggle}
              planModeEnabled={planModeEnabled}
              onTogglePlanMode={onTogglePlanMode}
            />
          </View>
          <Pressable
            style={[styles.sendButton, canSend ? styles.sendActive : styles.sendInactive]}
            onPress={handleSubmit}
            disabled={!canSend}
          >
            <Send size={16} color={canSend ? theme.colors.surface[0] : theme.colors.fg.faint} />
          </Pressable>
        </View>
      </View>
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
    fontFamily: theme.fontFamily.sans,
    color: theme.colors.fg.primary,
    minHeight: MIN_INPUT_HEIGHT,
    maxHeight: MAX_INPUT_HEIGHT,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
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
    width: 32,
    height: 32,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface[3],
  },
  attachButtonDisabled: {
    opacity: 0.6,
  },
  sendButton: {
    width: 32,
    height: 32,
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
