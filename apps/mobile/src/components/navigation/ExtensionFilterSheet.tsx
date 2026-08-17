import { memo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Check } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  isThreadStageId,
  THREAD_TAGS_EXTENSION_ID,
} from "@falcondeck/client-core";
import type {
  ExtensionSidebarFilterDefinition,
  ExtensionUiTone,
} from "@falcondeck/client-core";

import { NativeSheet, Text } from "@/components/ui";
import { stageColor, ThreadStageMark } from "@/components/chat/ThreadStageMark";

const TONE_COLORS: Partial<Record<ExtensionUiTone, string>> = {
  gray: "#94a3b8",
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
  pink: "#ec4899",
};

interface ExtensionFilterSheetProps {
  definitions: readonly ExtensionSidebarFilterDefinition[];
  selections: ReadonlyMap<string, ReadonlySet<string>>;
  onChange: (key: string, values: ReadonlySet<string>) => void;
  onClearAll: () => void;
  onClose: () => void;
}

export const ExtensionFilterSheet = memo(function ExtensionFilterSheet({
  definitions,
  selections,
  onChange,
  onClearAll,
  onClose,
}: ExtensionFilterSheetProps) {
  const { theme } = useUnistyles();
  const activeCount = definitions.reduce(
    (count, definition) => count + (selections.get(definition.key)?.size ?? 0),
    0,
  );

  return (
    <NativeSheet
      onClose={onClose}
      accessibilityLabel="Close thread filters"
      contentStyle={styles.content}
    >
      <View style={styles.header}>
        <Text variant="label" color="primary" weight="semibold">
          Filter threads
        </Text>
        {activeCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear all thread filters"
            onPress={() => {
              void Haptics.selectionAsync();
              onClearAll();
            }}
            hitSlop={8}
          >
            <Text variant="caption" color="accent" weight="medium">
              Clear all
            </Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView style={styles.list} bounces={false}>
        {definitions.map((definition) => {
          const node =
            definition.document?.root.type === "select"
              ? definition.document.root
              : null;
          if (!node) return null;
          const selected = selections.get(definition.key) ?? new Set<string>();

          return (
            <View key={definition.key} style={styles.group}>
              <Text
                variant="caption"
                color="muted"
                weight="medium"
                style={styles.groupLabel}
              >
                {node.label}
              </Text>
              {node.options.map((option) => {
                const checked = selected.has(option.value);
                const toneColor = option.tone
                  ? TONE_COLORS[option.tone]
                  : undefined;
                return (
                  <Pressable
                    key={option.value}
                    style={({ pressed }) => [
                      styles.option,
                      checked ? styles.optionSelected : undefined,
                      pressed ? styles.optionPressed : undefined,
                    ]}
                    accessibilityRole={node.multiple ? "checkbox" : "radio"}
                    accessibilityLabel={option.label}
                    accessibilityState={{ checked }}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      const next = new Set(node.multiple ? selected : []);
                      if (next.has(option.value)) next.delete(option.value);
                      else next.add(option.value);
                      onChange(definition.key, next);
                    }}
                  >
                    <View style={styles.optionLabel}>
                      {definition.extensionId === THREAD_TAGS_EXTENSION_ID ? (
                        <View
                          accessibilityElementsHidden
                          importantForAccessibility="no-hide-descendants"
                        >
                          <ThreadStageMark
                            stage={{
                              id: option.value,
                              label: option.label,
                              icon: isThreadStageId(option.value)
                                ? option.value
                                : "custom",
                            }}
                            color={stageColor(option.tone ?? "gray", theme)}
                          />
                        </View>
                      ) : toneColor ? (
                        <View
                          accessibilityElementsHidden
                          style={[
                            styles.swatch,
                            { backgroundColor: toneColor },
                          ]}
                        />
                      ) : null}
                      <Text variant="label" color="primary">
                        {option.label}
                      </Text>
                    </View>
                    {checked ? (
                      <Check
                        size={theme.iconSize.sm}
                        color={theme.colors.accent.default}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
    </NativeSheet>
  );
});

const styles = StyleSheet.create((theme) => ({
  content: {
    paddingHorizontal: theme.spacing[4],
  },
  header: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
  },
  list: {
    maxHeight: 420,
  },
  group: {
    paddingBottom: theme.spacing[3],
  },
  groupLabel: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  option: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.radius.lg,
  },
  optionSelected: {
    backgroundColor: theme.colors.surface[2],
  },
  optionPressed: {
    backgroundColor: theme.colors.surface[3],
  },
  optionLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  swatch: {
    width: 12,
    height: 12,
    borderRadius: theme.radius.full,
  },
}));
