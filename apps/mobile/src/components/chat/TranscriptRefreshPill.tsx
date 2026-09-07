import { memo, useEffect, useState } from "react";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { ActivityDiamond, Text } from "@/components/ui";

/** Loads faster than this never show a pill: a flash of "Updating…" on a
 * warm cache reads as jank, while a multi-second silent wait reads as a
 * frozen transcript. */
const SHOW_AFTER_MS = 350;

/**
 * Floats over the top of a transcript that is rendering cached messages while
 * the authoritative page is still on its way, so the reader knows newer
 * messages are coming instead of wondering why the thread looks short.
 */
export const TranscriptRefreshPill = memo(function TranscriptRefreshPill({
  visible,
}: {
  visible: boolean;
}) {
  const { theme } = useUnistyles();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!visible) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!shown) return null;

  return (
    <View style={styles.wrapper} pointerEvents="none">
      <View
        style={styles.pill}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel="Updating conversation"
        testID="transcript-refresh-pill"
      >
        <ActivityDiamond
          size={theme.iconSize.xs}
          color={theme.colors.accent.default}
        />
        <Text variant="caption" size="xs" color="secondary" weight="medium">
          Updating conversation…
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    position: "absolute",
    top: theme.spacing[2],
    left: 0,
    right: 0,
    alignItems: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.radius.full,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface[2],
    ...theme.shadow.md,
  },
}));
