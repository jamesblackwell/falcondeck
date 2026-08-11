import { memo, useCallback, useState } from "react";
import { Pressable } from "react-native";
import { Share2 } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  conversationExportFilename,
  conversationItemsToMarkdown,
  type ConversationItem,
} from "@falcondeck/client-core";

import { ActivityDiamond } from "@/components/ui";
import { shareEmbeddedArtifact } from "@/lib/artifact-export";

export const ConversationShareButton = memo(function ConversationShareButton({
  items,
  title,
  partial,
  onError,
}: {
  items: readonly ConversationItem[];
  title?: string | null;
  partial: boolean;
  onError?: (message: string) => void;
}) {
  const { theme } = useUnistyles();
  const [busy, setBusy] = useState(false);
  const share = useCallback(async () => {
    if (busy || items.length === 0) return;
    setBusy(true);
    try {
      const markdown = conversationItemsToMarkdown(items, { title, partial });
      await shareEmbeddedArtifact({
        filename: conversationExportFilename(title),
        mimeType: "text/markdown",
        text: markdown,
        dataUrl: null,
        byteSize: null,
      });
    } catch (cause) {
      onError?.(
        cause instanceof Error
          ? cause.message
          : "Could not share this conversation.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, items, onError, partial, title]);

  const label = partial
    ? "Share loaded conversation as Markdown. Earlier messages are not loaded."
    : "Share conversation as Markdown";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled: busy || items.length === 0 }}
      disabled={busy || items.length === 0}
      onPress={() => {
        void share();
      }}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      {busy ? (
        <ActivityDiamond size={theme.iconSize.md} color={theme.colors.fg.secondary} />
      ) : (
        <Share2
          accessible={false}
          size={theme.iconSize.md}
          color={theme.colors.fg.secondary}
        />
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  button: {
    minWidth: theme.minTouchTarget,
    minHeight: theme.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    borderCurve: "continuous",
  },
  pressed: {
    backgroundColor: theme.colors.surface[2],
  },
}));
