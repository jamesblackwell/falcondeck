import { memo, useCallback, useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { WebView } from 'react-native-webview'
import { Check, CircleX, Copy } from 'lucide-react-native'

import { Text, Button } from '@/components/ui'
import { useClipboardCopy } from '@/hooks/useClipboardCopy'
import { loadMermaidBrowserSource } from './mermaidEngine'
import {
  buildMermaidDocument,
  parseMermaidWebViewMessage,
} from './mermaidHtml'
import { mermaidPaletteFromTheme } from './mermaidPalette'

const INITIAL_DIAGRAM_HEIGHT = 120

export const MermaidBlock = memo(function MermaidBlock({
  code,
  pending = false,
}: {
  code: string
  /** Quiet parse failures while the enclosing fence may still be growing. */
  pending?: boolean
}) {
  const { theme } = useUnistyles()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [height, setHeight] = useState(INITIAL_DIAGRAM_HEIGHT)
  const { copy, result: copyResult } = useClipboardCopy(
    code,
    'Diagram source copied',
    'Could not copy diagram source',
  )
  const copyLabel = copyResult === 'copied' ? 'Copied' : copyResult === 'failed' ? 'Retry' : 'Copy'
  const copyAccessibilityLabel = copyResult === 'copied'
    ? 'Diagram source copied'
    : copyResult === 'failed'
      ? 'Could not copy diagram source. Retry'
      : 'Copy diagram source'
  const copyIcon = copyResult === 'copied' ? (
    <Check size={theme.iconSize.xs} color={theme.colors.success.default} />
  ) : copyResult === 'failed' ? (
    <CircleX size={theme.iconSize.xs} color={theme.colors.danger.default} />
  ) : (
    <Copy size={theme.iconSize.xs} color={theme.colors.fg.muted} />
  )

  useEffect(() => {
    let cancelled = false
    const trimmed = code.trim()
    if (!trimmed) {
      setHtml(null)
      setError(null)
      return
    }

    // The diagram is drawn inside the WebView, so a theme change has to be
    // baked into a fresh document rather than restyled in place.
    const palette = mermaidPaletteFromTheme(theme)
    void loadMermaidBrowserSource()
      .then((mermaidScript) => {
        if (cancelled) return
        setError(null)
        setHtml(
          buildMermaidDocument({
            source: trimmed,
            mermaidScript,
            palette,
          }),
        )
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setHtml(null)
        setError(reason instanceof Error ? reason.message : 'Could not render diagram')
      })

    return () => {
      cancelled = true
    }
  }, [code, theme])

  const onMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    const message = parseMermaidWebViewMessage(event.nativeEvent.data)
    if (!message) return
    if (message.type === 'ready') {
      setHeight(message.height)
      setError(null)
      return
    }
    setError(message.message)
  }, [])

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text variant="caption" color="muted" size="2xs">
          mermaid
        </Text>
        {error && !pending ? (
          <Text
            accessible
            accessibilityLiveRegion="polite"
            variant="caption"
            color="muted"
            size="2xs"
          >
            Could not render
          </Text>
        ) : null}
        {html ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showSource ? 'Show diagram' : 'Show source'}
            onPress={() => setShowSource((current) => !current)}
            style={styles.toggle}
          >
            <Text variant="caption" color="muted" size="2xs">
              {showSource ? 'Diagram' : 'Source'}
            </Text>
          </Pressable>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          label={copyLabel}
          icon={copyIcon}
          accessibilityLabel={copyAccessibilityLabel}
          accessibilityLiveRegion="polite"
          onPress={() => { void copy() }}
        />
      </View>
      {html && !showSource && !error ? (
        <WebView
          originWhitelist={['*']}
          source={{ html }}
          scrollEnabled={false}
          javaScriptEnabled
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={(request) =>
            request.url === 'about:blank' || request.url.startsWith('data:')
          }
          style={[styles.webview, { height }]}
        />
      ) : (
        <Text selectable variant="mono" color="secondary" style={styles.code}>
          {code}
        </Text>
      )}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface[1],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
    gap: theme.spacing[2],
  },
  toggle: {
    minHeight: theme.minTouchTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing[1],
  },
  code: {
    padding: theme.spacing[3],
    lineHeight: theme.fontSize.sm * theme.lineHeight.code,
    textAlign: 'left',
  },
  webview: {
    backgroundColor: 'transparent',
    width: '100%',
  },
}))
