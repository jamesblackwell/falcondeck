import { memo } from "react";
import { View } from "react-native";
import { CheckCircle2, CircleX, PauseCircle } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  codeReviewPresentation,
  contentLifecycle,
  type ConversationItem,
} from "@falcondeck/client-core";

import { ActivityDiamond, Text } from "@/components/ui";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageActions } from "./MessageActions";

type CodeReviewItem = Extract<ConversationItem, { kind: "code_review" }>;

export const CodeReviewBlock = memo(function CodeReviewBlock({
  item,
}: {
  item: CodeReviewItem;
}) {
  const { theme } = useUnistyles();
  const lifecycle = contentLifecycle(item);
  const presentation = codeReviewPresentation(lifecycle, item.subject);
  const hasContent = Boolean(item.content.trim());
  const isActive = lifecycle === "pending" || lifecycle === "streaming";
  const icon = isActive ? (
    <ActivityDiamond
      size={theme.iconSize.xs}
      color={theme.colors.accent.default}
    />
  ) : lifecycle === "error" ? (
    <CircleX
      accessible={false}
      size={theme.iconSize.xs}
      color={theme.colors.danger.default}
    />
  ) : lifecycle === "interrupted" ? (
    <PauseCircle
      accessible={false}
      size={theme.iconSize.xs}
      color={theme.colors.warning.default}
    />
  ) : (
    <CheckCircle2
      accessible={false}
      size={theme.iconSize.xs}
      color={theme.colors.success.default}
    />
  );

  if (!hasContent) {
    return (
      <View
        style={styles.receipt}
        accessible
        accessibilityRole={lifecycle === "error" ? "alert" : "text"}
        accessibilityLiveRegion={lifecycle === "error" ? "assertive" : "polite"}
        accessibilityLabel={`${presentation.label}. ${presentation.detail}`}
        accessibilityState={{ busy: isActive }}
      >
        {icon}
        <View style={styles.receiptCopy}>
          <Text
            variant="caption"
            size="xs"
            color="secondary"
            weight="medium"
            style={styles.centeredText}
          >
            {presentation.label}
          </Text>
          <Text
            variant="caption"
            size="2xs"
            color="muted"
            style={styles.centeredText}
          >
            {presentation.detail}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.card,
        lifecycle === "error" ? styles.errorCard : undefined,
        lifecycle === "interrupted" ? styles.interruptedCard : undefined,
      ]}
    >
      <View
        style={styles.header}
        accessible
        accessibilityRole={lifecycle === "error" ? "alert" : "text"}
        accessibilityLiveRegion={
          lifecycle === "error" ? "assertive" : isActive ? "polite" : "none"
        }
        accessibilityLabel={`${presentation.label}. ${presentation.detail}`}
        accessibilityState={{ busy: isActive }}
      >
        {icon}
        <View style={styles.headerCopy}>
          <Text variant="body" size="sm" color="primary" weight="semibold">
            {presentation.label}
          </Text>
          <Text variant="caption" size="xs" color="muted">
            {presentation.detail}
          </Text>
        </View>
      </View>
      <View style={styles.body}>
        <MarkdownRenderer
          text={item.content}
          streaming={isActive}
          interpretDirectives={false}
        />
      </View>
      <View style={styles.actions} accessible={false}>
        <MessageActions
          text={item.content}
          accessibilityLabel="Copy code review"
        />
        {lifecycle === "error" || lifecycle === "interrupted" ? (
          <Text
            variant="caption"
            size="xs"
            color={lifecycle === "error" ? "danger" : "warning"}
          >
            {lifecycle === "error" ? "Review failed" : "Review interrupted"}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  receipt: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: theme.spacing[2],
    justifyContent: "center",
    marginHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  receiptCopy: {
    alignItems: "center",
    flexShrink: 1,
    gap: theme.spacing[0.5],
  },
  centeredText: {
    textAlign: "center",
  },
  card: {
    backgroundColor: theme.colors.surface[1],
    borderColor: theme.colors.border.default,
    borderCurve: "continuous",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    marginHorizontal: theme.spacing[4],
    overflow: "hidden",
  },
  errorCard: {
    backgroundColor: theme.colors.danger.muted,
    borderColor: theme.colors.danger.default,
  },
  interruptedCard: {
    backgroundColor: theme.colors.warning.muted,
    borderColor: theme.colors.warning.default,
  },
  header: {
    alignItems: "flex-start",
    borderBottomColor: theme.colors.border.subtle,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  headerCopy: {
    flex: 1,
    gap: theme.spacing[0.5],
  },
  body: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[2],
  },
}));
