import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react-native";

import {
  serviceMessagePresentation,
  type ServiceNotice,
} from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { CodeBlock } from "./CodeBlock";

interface OperationalNoticeBannerProps {
  notice: ServiceNotice;
  onDismiss: (noticeId: string) => void;
}

export const OperationalNoticeBanner = memo(function OperationalNoticeBanner({
  notice,
  onDismiss,
}: OperationalNoticeBannerProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = serviceMessagePresentation(notice.level, notice.message);
  const { theme } = useUnistyles();
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
      </View>
      <Pressable
        onPress={() => onDismiss(notice.id)}
        accessibilityRole="button"
        accessibilityLabel="Dismiss notice"
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
}));
