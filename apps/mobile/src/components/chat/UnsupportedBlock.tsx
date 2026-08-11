import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {
  contentLifecycle,
  contentLifecycleLabel,
  providerOutputKindLabel,
  type ConversationItem,
} from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { TechnicalPayloadDetail } from "./TechnicalPayloadDetail";

export const UnsupportedBlock = memo(function UnsupportedBlock({
  item,
}: {
  item: unknown;
}) {
  const [open, setOpen] = useState(false);
  const record =
    item && typeof item === "object" ? (item as Record<string, unknown>) : null;
  const kind =
    typeof record?.output_kind === "string"
      ? record.output_kind
      : typeof record?.kind === "string"
        ? record.kind
        : "unknown";
  const lifecycle =
    record?.kind === "unsupported"
      ? contentLifecycle(
          record as Extract<ConversationItem, { kind: "unsupported" }>,
        )
      : "complete";
  const reason =
    typeof record?.reason === "string"
      ? record.reason
      : "This output is not supported.";
  const payload =
    record?.kind === "unsupported" && "payload" in record
      ? record.payload
      : item;
  const label = `Unsupported output: ${providerOutputKindLabel(kind)}`;

  return (
    <View
      style={[styles.container, lifecycle === "error" && styles.errorContainer]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${contentLifecycleLabel(lifecycle)}. ${reason}`}
        accessibilityHint={
          open ? "Hides technical details" : "Shows technical details"
        }
        accessibilityState={{ expanded: open }}
        accessibilityLiveRegion={
          lifecycle === "error"
            ? "assertive"
            : lifecycle === "streaming"
              ? "polite"
              : "none"
        }
        onPress={() => setOpen((value) => !value)}
        style={styles.header}
      >
        <Text
          variant="caption"
          color={lifecycle === "error" ? "danger" : "warning"}
        >
          {label} · {contentLifecycleLabel(lifecycle)}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={[styles.detail, lifecycle === "error" && styles.errorDetail]}
        >
          <Text selectable variant="caption" color="secondary" size="xs">
            {reason}
          </Text>
          <TechnicalPayloadDetail payload={payload} />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.warning.muted,
    borderColor: theme.colors.warning.default,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    overflow: "hidden",
  },
  header: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  errorContainer: {
    backgroundColor: theme.colors.danger.muted,
    borderColor: theme.colors.danger.default,
  },
  detail: {
    borderTopColor: theme.colors.warning.default,
    borderTopWidth: 1,
    padding: theme.spacing[3],
  },
  errorDetail: {
    borderTopColor: theme.colors.danger.default,
  },
}));
