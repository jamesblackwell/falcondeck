import { memo, useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { CircleX, X } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  imageInputLabel,
  isSafeNativeImageUrl,
  type ImageInput,
} from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { ImagePreviewModal } from "./ImagePreviewModal";

interface AttachmentPreviewListProps {
  attachments: ImageInput[];
  onRemoveAttachment?: (attachmentId: string) => void;
  disabled?: boolean;
}

export const AttachmentPreviewList = memo(function AttachmentPreviewList({
  attachments,
  onRemoveAttachment,
  disabled = false,
}: AttachmentPreviewListProps) {
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(
    null,
  );
  const previewAttachment = previewAttachmentId
    ? (attachments.find(
        (attachment) => attachment.id === previewAttachmentId,
      ) ?? null)
    : null;
  const openPreview = useCallback((attachment: ImageInput) => {
    setPreviewAttachmentId(attachment.id);
  }, []);
  const closePreview = useCallback(() => {
    setPreviewAttachmentId(null);
  }, []);

  useEffect(() => {
    if (previewAttachmentId && !previewAttachment) {
      setPreviewAttachmentId(null);
    }
  }, [previewAttachment, previewAttachmentId]);

  if (attachments.length === 0) return null;

  return (
    <>
      <View style={styles.container}>
        {attachments.map((attachment) => (
          <AttachmentCard
            key={attachment.id}
            attachment={attachment}
            disabled={disabled}
            onPreview={openPreview}
            onRemoveAttachment={onRemoveAttachment}
          />
        ))}
      </View>
      <ImagePreviewModal
        visible={previewAttachment != null}
        url={previewAttachment?.url ?? ""}
        label={previewAttachment ? imageInputLabel(previewAttachment) : "Image"}
        onClose={closePreview}
      />
    </>
  );
});

const AttachmentCard = memo(function AttachmentCard({
  attachment,
  disabled,
  onPreview,
  onRemoveAttachment,
}: {
  attachment: ImageInput;
  disabled: boolean;
  onPreview: (attachment: ImageInput) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
}) {
  const { theme } = useUnistyles();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const label = imageInputLabel(attachment);
  const url = attachment.url.trim();
  const renderable = isSafeNativeImageUrl(url) && failedUrl !== url;

  useEffect(() => setFailedUrl(null), [url]);

  return (
    <View style={styles.card}>
      {renderable ? (
        <Pressable
          onPress={() => onPreview(attachment)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${label}`}
          accessibilityHint="Opens the image full screen"
          accessibilityState={{ disabled }}
        >
          <Image
            source={{ uri: url }}
            recyclingKey={url}
            cachePolicy="memory-disk"
            contentFit="cover"
            style={styles.image}
            accessible={false}
            onError={() => setFailedUrl(url)}
          />
        </Pressable>
      ) : (
        <View
          style={styles.unavailable}
          accessible
          accessibilityLabel={`${label}, image unavailable`}
        >
          <CircleX
            accessible={false}
            size={theme.iconSize.sm}
            color={theme.colors.danger.default}
          />
          <Text variant="caption" color="danger" size="2xs">
            Unavailable
          </Text>
        </View>
      )}
      <Text
        variant="caption"
        color="secondary"
        size="2xs"
        numberOfLines={1}
        style={styles.label}
      >
        {label}
      </Text>
      {onRemoveAttachment ? (
        <Pressable
          style={[styles.removeButton, disabled && styles.removeButtonDisabled]}
          onPress={() => onRemoveAttachment(attachment.id)}
          hitSlop={12}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label}`}
          accessibilityState={{ disabled }}
        >
          <X
            accessible={false}
            size={theme.iconSize.xs}
            color={theme.colors.surface[0]}
          />
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  card: {
    width: 76,
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
    overflow: "hidden",
    backgroundColor: theme.colors.surface[1],
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    position: "relative",
  },
  image: {
    width: "100%",
    aspectRatio: 1,
    backgroundColor: theme.colors.surface[3],
  },
  unavailable: {
    width: "100%",
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface[2],
  },
  label: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  removeButton: {
    position: "absolute",
    top: theme.spacing[1],
    right: theme.spacing[1],
    width: 20,
    height: 20,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.overlayStrong,
  },
  removeButtonDisabled: {
    opacity: 0.5,
  },
}));
