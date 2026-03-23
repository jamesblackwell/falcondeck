import { memo } from 'react'
import { View, Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Image } from 'expo-image'
import { X } from 'lucide-react-native'

import type { ImageInput } from '@falcondeck/client-core'

import { Text } from '@/components/ui'

interface AttachmentPreviewListProps {
  attachments: ImageInput[]
  onRemoveAttachment?: (attachmentId: string) => void
  disabled?: boolean
}

function attachmentLabel(attachment: ImageInput) {
  if (attachment.name && attachment.name.trim().length > 0) {
    return attachment.name.trim()
  }

  if (!attachment.local_path || attachment.local_path.trim().length === 0) {
    return 'Image'
  }

  const segments = attachment.local_path.split('/')
  return segments[segments.length - 1] ?? 'Image'
}

export const AttachmentPreviewList = memo(function AttachmentPreviewList({
  attachments,
  onRemoveAttachment,
  disabled = false,
}: AttachmentPreviewListProps) {
  const { theme } = useUnistyles()

  if (attachments.length === 0) {
    return null
  }

  return (
    <View style={styles.container}>
      {attachments.map((attachment) => (
        <View key={attachment.id} style={styles.card}>
          <Image
            source={{ uri: attachment.url }}
            contentFit="cover"
            style={styles.image}
          />
          <Text
            variant="caption"
            color="secondary"
            size="2xs"
            numberOfLines={1}
            style={styles.label}
          >
            {attachmentLabel(attachment)}
          </Text>
          {onRemoveAttachment ? (
            <Pressable
              style={[styles.removeButton, disabled && styles.removeButtonDisabled]}
              onPress={() => onRemoveAttachment(attachment.id)}
              hitSlop={8}
              disabled={disabled}
            >
              <X size={12} color={theme.colors.surface[0]} />
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing[2],
  },
  card: {
    width: 76,
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: theme.colors.surface[1],
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    position: 'relative',
  },
  image: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: theme.colors.surface[3],
  },
  label: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  removeButton: {
    position: 'absolute',
    top: theme.spacing[1],
    right: theme.spacing[1],
    width: 20,
    height: 20,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  removeButtonDisabled: {
    opacity: 0.5,
  },
}))
