import { useState } from 'react'
import { Alert, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import type { ProjectFolder } from '@falcondeck/client-core'
import { Button, Input, NativeSheet, OptionSheet, Text } from '@/components/ui'
import { mutateProjectFolder } from '@/lib/project-folders'

export function ProjectFolderSheet({
  workspaceId,
  folder,
  onNewTask,
  onClose,
}: {
  workspaceId: string
  folder?: ProjectFolder
  onNewTask?: (workspaceId: string, folderId: string) => Promise<void>
  onClose: () => void
}) {
  const [mode, setMode] = useState(folder ? 'menu' : 'name')
  const [name, setName] = useState(folder?.name ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (pending || !name.trim()) return
    setPending(true)
    setError(null)
    try {
      await mutateProjectFolder(
        folder
          ? {
              action: 'rename',
              workspace_id: workspaceId,
              folder_id: folder.id,
              name: name.trim(),
            }
          : { action: 'create', workspace_id: workspaceId, name: name.trim() },
      )
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save folder')
    } finally {
      setPending(false)
    }
  }
  if (mode === 'menu' && folder)
    return (
      <OptionSheet
        title={folder.name}
        items={[
          ...(onNewTask ? [{ value: 'new', label: 'New task' }] : []),
          { value: 'rename', label: 'Rename folder' },
          {
            value: 'delete',
            label: 'Delete folder',
            description: 'Tasks return to the project root',
            destructive: true,
          },
        ]}
        onClose={onClose}
        onSelect={(action) => {
          if (action === 'rename') {
            setMode('name')
            return
          }
          onClose()
          const operation =
            action === 'new'
              ? onNewTask?.(workspaceId, folder.id)
              : mutateProjectFolder({
                  action: 'delete',
                  workspace_id: workspaceId,
                  folder_id: folder.id,
                })
          void operation?.catch((error: unknown) =>
            Alert.alert(
              'Could not update folder',
              error instanceof Error ? error.message : 'Please try again',
            ),
          )
        }}
      />
    )
  return (
    <NativeSheet
      onClose={() => {
        if (!pending) onClose()
      }}
      accessibilityLabel={folder ? 'Rename folder' : 'Create folder'}
    >
      <View style={styles.content}>
        <Text variant="label" weight="semibold">
          {folder ? 'Rename folder' : 'Create folder'}
        </Text>
        <Input
          accessibilityLabel="Folder name"
          placeholder="e.g. Chores"
          value={name}
          onChangeText={setName}
          maxLength={100}
          autoFocus
          selectTextOnFocus
          editable={!pending}
          onSubmitEditing={() => void save()}
          returnKeyType="done"
        />
        {error ? (
          <Text variant="caption" color="danger">
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="ghost"
            label="Cancel"
            onPress={onClose}
            disabled={pending}
          />
          <Button
            label={folder ? 'Save' : 'Create'}
            onPress={() => void save()}
            disabled={pending || !name.trim()}
            loading={pending}
          />
        </View>
      </View>
    </NativeSheet>
  )
}

export function ProjectFolderPickerSheet({
  workspaceId,
  threadId,
  folders,
  onClose,
}: {
  workspaceId: string
  threadId: string
  folders: readonly ProjectFolder[]
  onClose: () => void
}) {
  const [pending, setPending] = useState(false)
  const current =
    folders.find(
      (folder) =>
        folder.workspace_id === workspaceId &&
        folder.thread_ids.includes(threadId),
    )?.id ?? ''
  return (
    <OptionSheet
      title="Move task"
      selected={current}
      onClose={onClose}
      items={[
        {
          value: '',
          label: 'Project root',
          disabled: pending || current === '',
        },
        ...folders
          .filter((folder) => folder.workspace_id === workspaceId)
          .map((folder) => ({
            value: folder.id,
            label: folder.name,
            disabled: pending || folder.id === current,
          })),
      ]}
      onSelect={(folderId) => {
        if (pending) return
        setPending(true)
        void mutateProjectFolder({
          action: 'move_thread',
          workspace_id: workspaceId,
          thread_id: threadId,
          folder_id: folderId || null,
        })
          .then(onClose)
          .catch((error: unknown) =>
            Alert.alert(
              'Could not move task',
              error instanceof Error ? error.message : 'Please try again',
            ),
          )
          .finally(() => setPending(false))
      }}
    />
  )
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing[2],
  },
}))
