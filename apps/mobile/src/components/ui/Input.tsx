import { memo, useCallback, useState } from 'react'
import { TextInput, type TextInputProps } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

interface InputProps extends TextInputProps {
  error?: boolean
}

export const Input = memo(function Input({ error, style, ...props }: InputProps) {
  const { theme } = useUnistyles()
  const [isFocused, setIsFocused] = useState(false)

  /* v8 ignore start — focus/blur callbacks, tested via E2E */
  const handleFocus = useCallback(
    (e: Parameters<NonNullable<TextInputProps['onFocus']>>[0]) => {
      setIsFocused(true)
      props.onFocus?.(e)
    },
    [props.onFocus],
  )

  const handleBlur = useCallback(
    (e: Parameters<NonNullable<TextInputProps['onBlur']>>[0]) => {
      setIsFocused(false)
      props.onBlur?.(e)
    },
    [props.onBlur],
  )
  /* v8 ignore stop */

  return (
    <TextInput
      style={[
        styles.base,
        isFocused ? styles.focused : undefined,
        error ? styles.error : undefined,
        style,
      ]}
      placeholderTextColor={theme.colors.fg.muted}
      selectionColor={theme.colors.accent.default}
      onFocus={handleFocus}
      onBlur={handleBlur}
      {...props}
    />
  )
})

const styles = StyleSheet.create((theme) => ({
  base: {
    height: 44,
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface[2],
    paddingHorizontal: theme.spacing[3],
    fontSize: theme.fontSize.base,
    fontFamily: theme.fontFamily.sans,
    color: theme.colors.fg.primary,
  },
  focused: {
    borderColor: theme.colors.border.emphasis,
  },
  error: {
    borderColor: theme.colors.danger.default,
  },
}))
