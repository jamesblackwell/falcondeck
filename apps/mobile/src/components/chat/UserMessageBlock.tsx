import { memo, useCallback, useState } from "react";
import { Info, PencilLine } from "lucide-react-native";
import { View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { StyleSheet } from "react-native-unistyles";

import type { ConversationItem } from "@falcondeck/client-core";

import { AttachmentPreviewList } from "./AttachmentPreviewList";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageActions } from "./MessageActions";
import { Button, Text } from "@/components/ui";

type UserMessage = Extract<ConversationItem, { kind: "user_message" }>;

interface UserMessageBlockProps {
  item: UserMessage;
  onEditResend?: (item: UserMessage) => void;
  editResendUnavailableReason?: string | null;
}

export const UserMessageBlock = memo(function UserMessageBlock({
  item,
  onEditResend,
  editResendUnavailableReason = null,
}: UserMessageBlockProps) {
  const { theme } = useUnistyles();
  const [isBranching, setIsBranching] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [showEditUnavailableReason, setShowEditUnavailableReason] =
    useState(false);
  const hasText = item.text.trim().length > 0;
  const canEditResend = Boolean(onEditResend && item.turn_id);
  const unavailableReason = !item.turn_id
    ? "Edit and resend is unavailable because this message has no provider turn boundary."
    : canEditResend
      ? null
      : editResendUnavailableReason;
  const handleEditResend = useCallback(async () => {
    if (!onEditResend || isBranching) return;
    setBranchError(null);
    setIsBranching(true);
    try {
      await onEditResend(item);
    } catch {
      setBranchError("Could not create a branch. Select Edit to retry.");
    } finally {
      setIsBranching(false);
    }
  }, [isBranching, item, onEditResend]);
  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <AttachmentPreviewList attachments={item.attachments} />
        <MarkdownRenderer text={item.text} interpretDirectives={false} />
        {hasText || canEditResend || unavailableReason ? (
          <View style={styles.actions}>
            {canEditResend ? (
              <Button
                variant="ghost"
                size="icon"
                accessibilityLabel={
                  isBranching
                    ? "Creating new branch"
                    : "Edit and resend in a new branch"
                }
                accessibilityHint={
                  branchError ??
                  "Creates a new conversation branch with this message ready to edit"
                }
                loading={isBranching}
                icon={
                  <PencilLine
                    size={theme.iconSize.xs}
                    color={theme.colors.fg.muted}
                  />
                }
                onPress={() => {
                  void handleEditResend();
                }}
              />
            ) : null}
            {unavailableReason ? (
              <Button
                variant="ghost"
                size="icon"
                accessibilityLabel="Why edit and resend is unavailable"
                accessibilityHint={unavailableReason}
                accessibilityState={{ expanded: showEditUnavailableReason }}
                icon={
                  <Info
                    size={theme.iconSize.xs}
                    color={theme.colors.fg.faint}
                  />
                }
                onPress={() =>
                  setShowEditUnavailableReason((visible) => !visible)
                }
              />
            ) : null}
            {hasText ? (
              <MessageActions
                text={item.text}
                accessibilityLabel="Copy message"
              />
            ) : null}
          </View>
        ) : null}
        {showEditUnavailableReason && unavailableReason ? (
          <Text
            variant="caption"
            size="xs"
            color="muted"
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            style={styles.actionError}
          >
            {unavailableReason}
          </Text>
        ) : null}
        {branchError ? (
          <Text
            variant="caption"
            size="xs"
            color="danger"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={styles.actionError}
          >
            {branchError}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    alignItems: "flex-end",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
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
  actions: {
    minHeight: theme.minTouchTarget,
    alignItems: "flex-end",
    flexDirection: "row",
  },
  actionError: {
    textAlign: "right",
  },
}));
