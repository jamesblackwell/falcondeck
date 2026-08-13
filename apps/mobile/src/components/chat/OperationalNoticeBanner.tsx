import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react-native";

import {
  serviceMessagePresentation,
  type OperationalCondition,
} from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { CodeBlock } from "./CodeBlock";

interface OperationalNoticeBannerProps {
  conditions: readonly OperationalCondition[];
  onDismiss: (condition: OperationalCondition) => void;
}

export const OperationalNoticeBanner = memo(function OperationalNoticeBanner({
  conditions,
  onDismiss,
}: OperationalNoticeBannerProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const { theme } = useUnistyles();
  const notice = conditions[0];
  if (!notice) return null;
  const presentation = serviceMessagePresentation(notice.level, notice.message);
  const Icon =
    notice.level === "error"
      ? AlertCircle
      : notice.level === "warning"
        ? AlertTriangle
        : Info;
  const color =
    notice.level === "error"
      ? theme.colors.danger.default
      : notice.level === "warning"
        ? theme.colors.warning.default
        : theme.colors.info.default;

  return (
    <View
      style={[styles.container, styles[`level_${notice.level}`]]}
      accessibilityRole={notice.level === "error" ? "alert" : "summary"}
      accessibilityLiveRegion={
        notice.level === "error" ? "assertive" : "polite"
      }
    >
      <Icon accessible={false} size={theme.iconSize.xs} color={color} />
      <View style={styles.message}>
        <Text variant="caption" size="xs" color="secondary">
          {presentation.message}
        </Text>
        {presentation.rawDetail ? (
          <>
            <Pressable
              onPress={() => setDetailOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel="Technical details"
              accessibilityHint={
                detailOpen
                  ? "Hides technical details"
                  : "Shows technical details"
              }
              accessibilityState={{ expanded: detailOpen }}
              style={styles.detailButton}
            >
              <Text variant="caption" size="xs" color="secondary">
                Technical details
              </Text>
            </Pressable>
            {detailOpen ? (
              <CodeBlock
                code={presentation.rawDetail}
                language="diagnostic"
                previewLines={8}
              />
            ) : null}
          </>
        ) : null}
        {conditions.length > 1 ? (
          <View style={styles.issueCenter}>
            <Pressable
              onPress={() => setIssuesOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel={`${conditions.length} active issues`}
              accessibilityState={{ expanded: issuesOpen }}
              style={styles.detailButton}
            >
              <Text
                variant="caption"
                size="xs"
                weight="semibold"
                color="secondary"
              >
                {conditions.length} active issues
              </Text>
            </Pressable>
            {issuesOpen ? (
              <View style={styles.issueList}>
                {conditions.map((condition) => {
                  const issue = serviceMessagePresentation(
                    condition.level,
                    condition.message,
                  );
                  return (
                    <View key={condition.id} style={styles.issueRow}>
                      <Text
                        variant="caption"
                        size="xs"
                        color="secondary"
                        style={styles.issueMessage}
                      >
                        {issue.message}
                      </Text>
                      <Pressable
                        onPress={() => onDismiss(condition)}
                        accessibilityRole="button"
                        accessibilityLabel={`Dismiss issue: ${issue.message}`}
                        hitSlop={(theme.minTouchTarget - theme.iconSize.sm) / 2}
                      >
                        <Text variant="caption" size="xs" color="muted">
                          Dismiss
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      <Pressable
        onPress={() => onDismiss(notice)}
        accessibilityRole="button"
        accessibilityLabel="Dismiss issue"
        hitSlop={(theme.minTouchTarget - theme.iconSize.sm) / 2}
      >
        <X
          accessible={false}
          size={theme.iconSize.sm}
          color={theme.colors.fg.muted}
        />
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderRadius: theme.radius.md,
  },
  level_error: {
    backgroundColor: theme.colors.danger.muted,
    borderColor: theme.colors.danger.default,
  },
  level_warning: {
    backgroundColor: theme.colors.warning.muted,
    borderColor: theme.colors.warning.default,
  },
  level_info: {
    backgroundColor: theme.colors.info.muted,
    borderColor: theme.colors.border.subtle,
  },
  message: {
    flex: 1,
    gap: theme.spacing[1],
  },
  detailButton: {
    minHeight: theme.minTouchTarget,
    justifyContent: "center",
  },
  issueCenter: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    marginTop: theme.spacing[1],
    paddingTop: theme.spacing[1],
  },
  issueList: {
    gap: theme.spacing[2],
  },
  issueRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surface[2],
  },
  issueMessage: {
    flex: 1,
  },
}));
