import { memo, useCallback } from 'react'
import { View, TextInput, Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Send } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import type { ModelSummary } from '@falcondeck/client-core'

import { InputToolbar } from './InputToolbar'
import { StopButton } from './StopButton'

interface ChatInputProps {
  value: string
  onChangeText: (text: string) => void
  onSubmit: () => void
  onStop: () => void
  disabled?: boolean
  isRunning?: boolean
  placeholder?: string
  models: ModelSummary[]
  selectedModel: string | null
  selectedEffort: string | null
  onSelectModel: (modelId: string | null) => void
  onSelectEffort: (effort: string | null) => void
}

export const ChatInput = memo(function ChatInput({
  value,
  onChangeText,
  onSubmit,
  onStop,
  disabled,
  isRunning,
  placeholder = 'Ask your agent...',
  models,
  selectedModel,
  selectedEffort,
  onSelectModel,
  onSelectEffort,
}: ChatInputProps) {
  const { theme } = useUnistyles()

  const handleSubmit = useCallback(() => {
    if (!value.trim() || disabled) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onSubmit()
  }, [value, disabled, onSubmit])

  const canSend = value.trim().length > 0 && !disabled && !isRunning

  return (
    <View style={styles.container}>
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.fg.muted}
          selectionColor={theme.colors.accent.default}
          multiline
          maxLength={100_000}
          editable={!disabled}
        />
        <View style={styles.footer}>
          <InputToolbar
            models={models}
            selectedModel={selectedModel}
            selectedEffort={selectedEffort}
            onSelectModel={onSelectModel}
            onSelectEffort={onSelectEffort}
          />
          {isRunning ? (
            <StopButton onPress={onStop} />
          ) : (
            <Pressable
              style={[styles.sendButton, canSend ? styles.sendActive : styles.sendInactive]}
              onPress={handleSubmit}
              disabled={!canSend}
            >
              <Send size={16} color={canSend ? theme.colors.surface[0] : theme.colors.fg.faint} />
            </Pressable>
          )}
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
  },
  input: {
    fontSize: theme.fontSize.base,
    fontFamily: theme.fontFamily.sans,
    color: theme.colors.fg.primary,
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
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
