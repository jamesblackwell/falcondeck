import { memo, useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, useWindowDimensions, View } from 'react-native'
import { Image } from 'expo-image'
import { CircleX, X } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { Text } from '@/components/ui'

const PREVIEW_CARD_MAX_WIDTH = 640

export function imagePreviewLayout(
  viewportWidth: number,
  viewportHeight: number,
  padding: number,
  captionHeight: number,
) {
  const cardWidth = Math.min(
    PREVIEW_CARD_MAX_WIDTH,
    Math.max(0, viewportWidth - padding * 2),
  )
  const cardMaxHeight = Math.max(0, (viewportHeight - padding * 2) * 0.9)
  return {
    cardMaxHeight,
    mediaHeight: Math.max(0, Math.min(cardWidth, cardMaxHeight - captionHeight)),
  }
}

export const ImagePreviewModal = memo(function ImagePreviewModal({
  visible,
  url,
  label,
  onClose,
}: {
  visible: boolean
  url: string
  label: string
  onClose: () => void
}) {
  const { theme } = useUnistyles()
  const { width, height } = useWindowDimensions()
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const previewPadding = theme.spacing[4]
  const captionHeight = theme.minTouchTarget
  const responsiveStyles = useMemo(
    () => {
      const layout = imagePreviewLayout(
        width,
        height,
        previewPadding,
        captionHeight,
      )
      return {
        card: { maxHeight: layout.cardMaxHeight },
        media: { height: layout.mediaHeight },
      }
    },
    [captionHeight, height, previewPadding, width],
  )

  useEffect(() => {
    if (visible) setFailedUrl(null)
  }, [url, visible])

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {visible ? (
        <View style={styles.previewOverlay} accessibilityViewIsModal>
          <Pressable
            style={styles.previewBackdrop}
            onPress={onClose}
            accessible={false}
          />
          <View style={[styles.previewCard, responsiveStyles.card]}>
            {failedUrl === url ? (
              <View
                style={[styles.previewUnavailable, responsiveStyles.media]}
                accessible
                accessibilityRole="image"
                accessibilityLabel={`${label}, image unavailable`}
              >
                <CircleX
                  accessible={false}
                  size={theme.iconSize.xl}
                  color={theme.colors.danger.default}
                />
                <Text variant="label" color="muted">Image unavailable</Text>
              </View>
            ) : (
              <Image
                source={{ uri: url }}
                recyclingKey={url}
                cachePolicy="memory-disk"
                contentFit="contain"
                style={[styles.previewImage, responsiveStyles.media]}
                accessible
                accessibilityLabel={label}
                onError={() => setFailedUrl(url)}
              />
            )}
            <View style={styles.previewCaption}>
              <Text
                variant="caption"
                color="secondary"
                numberOfLines={1}
                style={styles.previewLabel}
              >
                {label}
              </Text>
              <Pressable
                style={styles.closeButton}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close image preview"
              >
                <X
                  accessible={false}
                  size={theme.iconSize.sm}
                  color={theme.colors.fg.primary}
                />
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </Modal>
  )
})

const styles = StyleSheet.create((theme) => ({
  previewOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing[4],
  },
  previewBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.overlay,
  },
  previewCard: {
    width: '100%',
    maxWidth: PREVIEW_CARD_MAX_WIDTH,
    overflow: 'hidden',
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.surface[1],
  },
  previewImage: {
    width: '100%',
    backgroundColor: theme.colors.surface[0],
  },
  previewUnavailable: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface[0],
  },
  previewCaption: {
    minHeight: theme.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
  },
  previewLabel: {
    flex: 1,
  },
  closeButton: {
    width: theme.minTouchTarget,
    height: theme.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
}))
