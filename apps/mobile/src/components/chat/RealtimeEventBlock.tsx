import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Radio } from "lucide-react-native";

import { type ConversationItem } from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { TechnicalPayloadDetail } from "./TechnicalPayloadDetail";

type RealtimeItem = Extract<ConversationItem, { kind: "realtime" }>;

export const RealtimeEventBlock = memo(function RealtimeEventBlock({
  item,
}: {
  item: RealtimeItem;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={item.title}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={styles.header}
      >
        <Radio accessible={false} size={16} style={styles.icon} />
        <View style={styles.copy}>
          <Text variant="caption" weight="medium">
            {item.title}
          </Text>
          {item.summary ? (
            <Text variant="caption" color="muted">
              {item.summary}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {open ? (
        <View style={styles.detail}>
          <TechnicalPayloadDetail payload={item.payload} />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.accent.muted,
    borderColor: theme.colors.accent.default,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    overflow: "hidden",
  },
  header: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  icon: { color: theme.colors.accent.default, marginTop: 1 },
  copy: { flex: 1, gap: theme.spacing[1] },
  detail: {
    borderTopColor: theme.colors.accent.default,
    borderTopWidth: 1,
    padding: theme.spacing[3],
  },
}));
