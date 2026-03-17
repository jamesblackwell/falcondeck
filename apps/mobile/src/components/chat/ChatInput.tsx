import { memo, useCallback } from 'react'
import { View, TextInput, Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Send } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

interface ChatInputProps {
  value: string
  onChangeText: (text: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
}

export const ChatInput = memo(function ChatInput({
  value,
  onChangeText,
  onSubmit,
  disabled,
  placeholder = 'Send a message...',
}: ChatInputProps) {
  const { theme } = useUnistyles()

  /* v8 ignore start — Pressable callback with haptics, tested via E2E */
  const handleSubmit = useCallback(() => {
    if (!value.trim() || disabled) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    onSubmit()
  }, [value, disabled, onSubmit])
  /* v8 ignore stop */

  const canSend = value.trim().length > 0 && !disabled

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
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
        <Pressable
          style={[styles.sendButton, canSend ? styles.sendActive : styles.sendInactive]}
          onPress={handleSubmit}
          disabled={!canSend}
        >
          <Send size={18} color={canSend ? theme.colors.surface[0] : theme.colors.fg.faint} />
        </Pressable>
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
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface[2],
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  input: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontFamily: theme.fontFamily.sans,
    color: theme.colors.fg.primary,
    maxHeight: 120,
    paddingTop: 0,
    paddingBottom: 0,
  },
  sendButton: {
    width: 36,
    height: 36,
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
