import { memo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { ConversationItem } from "@falcondeck/client-core";

import { AttachmentPreviewList } from "./AttachmentPreviewList";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageActions } from "./MessageActions";
type UserMessage = Extract<ConversationItem, { kind: "user_message" }>;

interface UserMessageBlockProps {
  item: UserMessage;
}

export const UserMessageBlock = memo(function UserMessageBlock({
  item,
}: UserMessageBlockProps) {
  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <AttachmentPreviewList attachments={item.attachments} />
        <MarkdownRenderer text={item.text} interpretDirectives={false} />
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
}));
