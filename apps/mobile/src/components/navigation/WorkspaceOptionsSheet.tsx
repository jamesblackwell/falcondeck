import { memo, useCallback, useState } from 'react'
import { Pressable, View } from 'react-native'
import { FolderClosed, Globe, Sparkles } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import {
  domainFromUserInput,
  normalizePreferences,
  type WorkspaceIconPreference,
} from '@falcondeck/client-core'

import { Button, Input, NativeSheet, Text } from '@/components/ui'
import { useRelayStore, useSessionStore } from '@/store'

interface WorkspaceOptionsSheetProps {
  workspaceId: string
  workspaceName: string
  onClose: () => void
}

export const WorkspaceOptionsSheet = memo(function WorkspaceOptionsSheet({
  workspaceId,
  workspaceName,
  onClose,
}: WorkspaceOptionsSheetProps) {
  const { theme } = useUnistyles()
  const preference = useSessionStore(
    (state) => state.snapshot?.preferences.workspace_icons?.[workspaceId],
  )
  const setPreferences = useSessionStore((state) => state.setPreferences)
  const [mode, setMode] = useState<'menu' | 'website'>('menu')
  const [website, setWebsite] = useState(preference?.domain ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = preference?.mode ?? 'auto'

  const save = useCallback(
    async (icon: WorkspaceIconPreference | null) => {
      setPending(true)
      setError(null)
      try {
        const current = useSessionStore.getState().snapshot?.preferences.workspace_icons ?? {}
        const nextIcons = { ...current }
        if (icon) nextIcons[workspaceId] = icon
        else delete nextIcons[workspaceId]
        const updated = await useRelayStore.getState()._callRpc('preferences.update', {
          workspace_icons: nextIcons,
        })
        setPreferences(normalizePreferences(updated))
        onClose()
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Failed to save icon')
      } finally {
        setPending(false)
      }
    },
    [onClose, setPreferences, workspaceId],
  )

  if (mode === 'website') {
    return (
      <NativeSheet onClose={onClose} accessibilityLabel="Website icon">
        <View style={styles.sheet}>
          <Text variant="label" color="primary" weight="semibold">
            Website icon
          </Text>
          <Text variant="supporting" color="secondary">
            {workspaceName}
          </Text>
          <Input
            value={website}
            onChangeText={setWebsite}
            placeholder="example.com"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
          />
          {error ? (
            <Text variant="caption" color="danger">
              {error}
            </Text>
          ) : null}
          <Button
            onPress={() => {
              const domain = domainFromUserInput(website)
              if (!domain) {
                setError('Enter a website like example.com')
                return
              }
              void Haptics.selectionAsync()
              void save({ mode: 'domain', domain })
            }}
            disabled={pending}
          >
            Use website
          </Button>
        </View>
      </NativeSheet>
    )
  }

  return (
    <NativeSheet onClose={onClose} accessibilityLabel={`Icon for ${workspaceName}`}>
      <View style={styles.sheet}>
        <Text variant="label" color="primary" weight="semibold">
          Icon
        </Text>
        <Text variant="supporting" color="secondary">
          {workspaceName}
        </Text>
        <Pressable
          style={styles.row}
          onPress={() => {
            void Haptics.selectionAsync()
            void save(null)
          }}
          disabled={pending}
          accessibilityRole="button"
          accessibilityState={{ selected: selected === 'auto' }}
        >
          <Sparkles size={theme.iconSize.sm} color={theme.colors.fg.muted} />
          <Text variant="body" color="primary" style={styles.rowLabel}>
            Auto
          </Text>
        </Pressable>
        <Pressable
          style={styles.row}
          onPress={() => {
            void Haptics.selectionAsync()
            void save({ mode: 'folder' })
          }}
          disabled={pending}
          accessibilityRole="button"
          accessibilityState={{ selected: selected === 'folder' }}
        >
          <FolderClosed size={theme.iconSize.sm} color={theme.colors.fg.muted} />
          <Text variant="body" color="primary" style={styles.rowLabel}>
            Folder
          </Text>
        </Pressable>
        <Pressable
          style={styles.row}
          onPress={() => {
            void Haptics.selectionAsync()
            setMode('website')
          }}
          disabled={pending}
          accessibilityRole="button"
          accessibilityState={{ selected: selected === 'domain' }}
        >
          <Globe size={theme.iconSize.sm} color={theme.colors.fg.muted} />
          <Text variant="body" color="primary" style={styles.rowLabel}>
            {selected === 'domain' && preference?.domain ? preference.domain : 'Website…'}
          </Text>
        </Pressable>
        {error ? (
          <Text variant="caption" color="danger">
            {error}
          </Text>
        ) : null}
      </View>
    </NativeSheet>
  )
})

const styles = StyleSheet.create((theme) => ({
  sheet: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
    minHeight: 44,
  },
  rowLabel: {
    flex: 1,
  },
}))
