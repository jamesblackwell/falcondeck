import { memo, useCallback, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Share2 } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ActivityDiamond, Text } from "@/components/ui";
import { shareEmbeddedArtifact } from "@/lib/artifact-export";

export const ArtifactShareButton = memo(function ArtifactShareButton({
  filename,
  mimeType,
  text,
  dataUrl = null,
  byteSize = null,
}: {
  filename: string;
  mimeType: string | null;
  text: string | null;
  dataUrl?: string | null;
  byteSize?: number | null;
}) {
  const { theme } = useUnistyles();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const share = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await shareEmbeddedArtifact({
        filename,
        mimeType,
        text,
        dataUrl,
        byteSize,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not share this artifact.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [byteSize, dataUrl, filename, mimeType, text]);

  return (
    <View style={styles.action}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Share ${filename}`}
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPress={() => {
          void share();
        }}
        style={styles.button}
      >
        {busy ? (
          <ActivityDiamond
            size={theme.iconSize.xs}
            color={theme.colors.accent.default}
          />
        ) : (
          <Share2
            accessible={false}
            size={theme.iconSize.xs}
            color={theme.colors.accent.default}
          />
        )}
        <Text variant="caption" color="accent" size="2xs" weight="semibold">
          {busy ? "PREPARING" : "SHARE"}
        </Text>
      </Pressable>
      {error ? (
        <Text
          variant="caption"
          color="danger"
          size="2xs"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  action: {
    maxWidth: 180,
    alignSelf: "flex-end",
    alignItems: "flex-end",
    gap: theme.spacing[1],
  },
  button: {
    minWidth: theme.minTouchTarget,
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.radius.sm,
    borderCurve: "continuous",
    paddingHorizontal: theme.spacing[2],
  },
}));
