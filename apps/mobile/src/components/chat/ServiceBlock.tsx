import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AlertTriangle, Info } from "lucide-react-native";

import {
  serviceMessagePresentation,
  type ConversationItem,
} from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { CodeBlock } from "./CodeBlock";

type ServiceItem = Extract<ConversationItem, { kind: "service" }>;

interface ServiceBlockProps {
  item: ServiceItem;
}

export const ServiceBlock = memo(function ServiceBlock({
  item,
}: ServiceBlockProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = serviceMessagePresentation(item.level, item.message);
  const { theme } = useUnistyles();
  const important = item.level === "warning" || item.level === "error";
  const Icon = item.level === "info" ? Info : AlertTriangle;
  const color =
    item.level === "error"
      ? theme.colors.danger.default
      : item.level === "warning"
        ? theme.colors.warning.default
        : theme.colors.fg.muted;
  return (
    <View
      style={[
        styles.row,
        important ? styles.important : null,
        item.level === "warning" ? styles.warning : null,
        item.level === "error" ? styles.error : null,
      ]}
      accessibilityRole={important ? "alert" : undefined}
      accessibilityLiveRegion={important ? "assertive" : "polite"}
    >
      <Icon accessible={false} size={14} color={color} />
      <View
        style={[styles.content, important ? styles.contentImportant : null]}
      >
        <Text
          selectable
          variant="caption"
          color={
            item.level === "error"
              ? "danger"
              : item.level === "warning"
                ? "warning"
                : "muted"
          }
          style={[styles.text, important ? styles.textImportant : null]}
        >
          {presentation.message}
        </Text>
        {presentation.rawDetail ? (
          <View style={styles.detail}>
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
          </View>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  important: {
    justifyContent: "flex-start",
    alignItems: "flex-start",
    borderWidth: 1,
    borderRadius: theme.radius.md,
    borderCurve: "continuous",
    paddingHorizontal: theme.spacing[3],
  },
  warning: {
    borderColor: theme.colors.warning.default,
    backgroundColor: theme.colors.warning.muted,
  },
  error: {
    borderColor: theme.colors.danger.default,
    backgroundColor: theme.colors.danger.muted,
  },
  text: {
    textAlign: "center",
    fontStyle: "italic",
  },
  content: {
    alignItems: "center",
    gap: theme.spacing[1],
  },
  contentImportant: {
    flex: 1,
    alignItems: "stretch",
  },
  textImportant: {
    flex: 1,
    textAlign: "left",
    fontStyle: "normal",
  },
  detail: {
    gap: theme.spacing[1],
  },
  detailButton: {
    minHeight: theme.minTouchTarget,
    justifyContent: "center",
  },
}));
