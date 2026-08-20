import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp } from "lucide-react-native";

import type { ConversationItem } from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { useCollapseLongUserMessages } from "@/store";
import { AttachmentPreviewList } from "./AttachmentPreviewList";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageActions } from "./MessageActions";
type UserMessage = Extract<ConversationItem, { kind: "user_message" }>;

/** Six-ish body lines; a taller sent message (a pasted wall of text, a
    handoff prompt) clamps behind a fade instead of filling the screen. */
const COLLAPSED_USER_MESSAGE_MAX_HEIGHT = 160;

interface UserMessageBlockProps {
  item: UserMessage;
}

export const UserMessageBlock = memo(function UserMessageBlock({
  item,
}: UserMessageBlockProps) {
  const { theme } = useUnistyles();
  const collapseLongMessages = useCollapseLongUserMessages();
  const collapsible = collapseLongMessages && item.text.trim().length > 0;
  const [expanded, setExpanded] = useState(false);
  const [textHeight, setTextHeight] = useState(0);
  // FlashList recycles instances across blocks; without this render-phase
  // reset, one expanded message leaks its state (and stale measurement) into
  // whichever user message the cell renders next.
  const [appliedItemId, setAppliedItemId] = useState(item.id);
  if (appliedItemId !== item.id) {
    setAppliedItemId(item.id);
    setExpanded(false);
    setTextHeight(0);
  }

  // The text keeps its natural height inside the clamped wrapper, so onLayout
  // reports the unclamped size even while collapsed.
  const overflowing =
    collapsible && textHeight > COLLAPSED_USER_MESSAGE_MAX_HEIGHT + 1;
  const collapsed = overflowing && !expanded;

  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <AttachmentPreviewList attachments={item.attachments} />
        <View style={collapsed ? styles.clampedText : null}>
          <View
            onLayout={
              collapsible
                ? (event) => setTextHeight(event.nativeEvent.layout.height)
                : undefined
            }
          >
            <MarkdownRenderer
              text={item.text}
              interpretDirectives={false}
              highlightCommands
            />
          </View>
          {collapsed ? (
            <Pressable
              style={styles.fade}
              onPress={() => setExpanded(true)}
              accessibilityRole="button"
              accessibilityLabel="Show the full message"
            >
              <View style={styles.revealChip}>
                <Text variant="label" color="muted">
                  Show more
                </Text>
                <ChevronDown
                  accessible={false}
                  size={theme.iconSize.xs}
                  color={theme.colors.fg.muted}
                />
              </View>
            </Pressable>
          ) : null}
        </View>
        {overflowing && expanded ? (
          <Pressable
            style={styles.collapseRow}
            onPress={() => setExpanded(false)}
            accessibilityRole="button"
            accessibilityLabel="Collapse the message"
          >
            <Text variant="label" color="muted">
              Show less
            </Text>
            <ChevronUp
              accessible={false}
              size={theme.iconSize.xs}
              color={theme.colors.fg.muted}
            />
          </Pressable>
        ) : null}
      </View>
      <MessageActions
        text={item.text}
        accessibilityLabel="Copy message"
        readAloudKey={item.id}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    alignItems: "flex-end",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[1],
  },
  bubble: {
    maxWidth: "80%",
    backgroundColor: theme.colors.surface[3],
    borderRadius: theme.radius.xl,
    borderCurve: "continuous",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  clampedText: {
    maxHeight: COLLAPSED_USER_MESSAGE_MAX_HEIGHT,
    overflow: "hidden",
  },
  fade: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 56,
    justifyContent: "flex-end",
    alignItems: "center",
    experimental_backgroundImage: `linear-gradient(to top, ${theme.colors.surface[3]} 25%, transparent)`,
  },
  revealChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    // Solid backing keeps the label readable if the gradient is unavailable.
    backgroundColor: theme.colors.surface[3],
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing[2],
  },
  collapseRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: theme.minTouchTarget,
  },
}));
