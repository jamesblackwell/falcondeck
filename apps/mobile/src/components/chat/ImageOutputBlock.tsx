import { memo, useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { CircleX, ExternalLink, ImageIcon } from "lucide-react-native";

import {
  contentLifecycle,
  isSafeMediaUrl,
  safeExternalUrl,
  type ConversationItem,
} from "@falcondeck/client-core";

import { ActivityDiamond, Text } from "@/components/ui";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { useExternalUrl } from "./useExternalUrl";

type ImageItem = Extract<ConversationItem, { kind: "image" }>;

export const ImageOutputBlock = memo(function ImageOutputBlock({
  item,
}: {
  item: ImageItem;
}) {
  const { theme } = useUnistyles();
  const lifecycle = contentLifecycle(item);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const url = item.image.url.trim();
  const safeUrl = isSafeMediaUrl(url, "image");
  const failed = url.length > 0 && failedUrl === url;
  const active = lifecycle === "pending" || lifecycle === "streaming";
  const alt =
    item.image.alt_text?.trim() ||
    item.title?.trim() ||
    item.image.name?.trim() ||
    "Agent image";
  const originalUrl = safeExternalUrl(url);
  const externalUrl = useExternalUrl(originalUrl ?? "");
  const closePreview = useCallback(() => setPreviewOpen(false), []);

  const image =
    safeUrl && !failed ? (
      <Image
        source={{ uri: url }}
        recyclingKey={url}
        cachePolicy="memory-disk"
        contentFit="contain"
        style={styles.image}
        accessible={false}
        onError={() => setFailedUrl(url)}
      />
    ) : null;

  return (
    <>
      <View style={styles.container}>
        <View
          style={[
            styles.media,
            image || active ? styles.mediaCanvas : styles.mediaUnavailable,
          ]}
        >
          {image ? (
            <Pressable
              onPress={() => setPreviewOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`Preview ${alt}`}
              accessibilityHint="Opens the image full screen"
            >
              {image}
            </Pressable>
          ) : active ? (
            <View
              style={styles.placeholder}
              accessible
              accessibilityLabel="Generating image"
              accessibilityLiveRegion="polite"
            >
              <ActivityDiamond
                size={theme.iconSize.sm}
                color={theme.colors.accent.default}
              />
              <Text variant="caption" color="muted">
                Generating image…
              </Text>
            </View>
          ) : (
            <View
              style={styles.placeholder}
              accessible
              accessibilityRole={lifecycle === "error" ? "alert" : undefined}
              accessibilityLabel="Image unavailable"
              accessibilityLiveRegion={
                lifecycle === "error" ? "assertive" : "polite"
              }
            >
              <CircleX
                accessible={false}
                size={theme.iconSize.sm}
                color={theme.colors.danger.default}
              />
              <Text variant="caption" color="danger">
                Image unavailable
              </Text>
            </View>
          )}
        </View>
        <View style={styles.caption}>
          <ImageIcon
            accessible={false}
            size={theme.iconSize.xs}
            color={theme.colors.fg.faint}
          />
          <Text
            variant="caption"
            color="muted"
            numberOfLines={1}
            style={styles.label}
          >
            {item.title?.trim() || item.image.name?.trim() || "Image"}
          </Text>
          {lifecycle === "interrupted" ? (
            <Text variant="caption" size="xs" color="warning">
              Interrupted
            </Text>
          ) : null}
          {lifecycle === "error" && url && !failed ? (
            <Text variant="caption" size="xs" color="danger">
              Failed
            </Text>
          ) : null}
          {originalUrl && image ? (
            <Pressable
              style={styles.openOriginal}
              onPress={() => {
                void externalUrl.open();
              }}
              accessibilityRole="link"
              accessibilityLabel="Open original image"
              accessibilityHint={
                externalUrl.opening
                  ? "Opening the original image outside FalconDeck"
                  : externalUrl.failed
                    ? "Retries opening the original image outside FalconDeck"
                    : "Opens the original image outside FalconDeck"
              }
              accessibilityState={{ busy: externalUrl.opening }}
              hitSlop={8}
            >
              <ExternalLink
                accessible={false}
                size={theme.iconSize.xs}
                color={theme.colors.fg.muted}
              />
            </Pressable>
          ) : null}
        </View>
        {externalUrl.failed ? (
          <View
            style={styles.openError}
            accessible
            accessibilityRole="alert"
            accessibilityLabel="Could not open the original image. Try again."
          >
            <Text variant="caption" size="xs" color="danger">
              Could not open the original image. Try again.
            </Text>
          </View>
        ) : null}
      </View>
      <ImagePreviewModal
        visible={previewOpen && Boolean(image)}
        url={url}
        label={alt}
        onClose={closePreview}
      />
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    overflow: "hidden",
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[1],
  },
  media: {
    width: "100%",
    justifyContent: "center",
    backgroundColor: theme.colors.surface[0],
  },
  mediaCanvas: {
    aspectRatio: 4 / 3,
  },
  mediaUnavailable: {
    minHeight: 96,
  },
  image: {
    width: "100%",
    aspectRatio: 4 / 3,
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  caption: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  label: {
    flex: 1,
  },
  openOriginal: {
    width: theme.minTouchTarget,
    height: theme.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  openError: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
}));
