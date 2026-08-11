import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Brain, ChevronRight, CircleX, PauseCircle } from "lucide-react-native";

import {
  contentLifecycle,
  formatDurationMs,
  type ConversationItem,
  type ThinkingDisplay,
} from "@falcondeck/client-core";

import { ActivityDiamond, Text } from "@/components/ui";
import { useThinkingDisplay } from "@/store";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { reasoningHeaderLabel, resolveReasoningReveal } from "./reasoning";

type ReasoningItem = Extract<ConversationItem, { kind: "reasoning" }>;

interface ReasoningBlockProps {
  item: ReasoningItem;
  display: ThinkingDisplay;
  /** Set when the thought renders inside a work session, which draws its own rule. */
  nested?: boolean;
}

/** The agent's thinking, rendered as a quiet left rule rather than a card —
    it is context for the work, not a result of it. */
export const ReasoningBlock = memo(function ReasoningBlock({
  item,
  display,
  nested = false,
}: ReasoningBlockProps) {
  const { theme } = useUnistyles();
  const lifecycle = contentLifecycle(item);
  const activelyStreaming =
    lifecycle === "pending" || lifecycle === "streaming";
  const { collapsedLines, defaultOpen } = resolveReasoningReveal(
    display,
    lifecycle,
  );
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  // FlashList recycles instances across blocks; without this render-phase
  // reset a thought the user expanded leaks its open state into whichever
  // reasoning row the cell renders next, flickering rows during scroll.
  const revealKey = `${item.id}:${display}`;
  const [appliedRevealKey, setAppliedRevealKey] = useState(revealKey);
  if (appliedRevealKey !== revealKey) {
    setAppliedRevealKey(revealKey);
    setOpenOverride(null);
  }

  const isOpen = openOverride ?? defaultOpen;
  const label = activelyStreaming
    ? "Thinking…"
    : lifecycle === "interrupted"
      ? "Thought interrupted"
      : lifecycle === "error"
        ? "Thought failed"
        : reasoningHeaderLabel(item.summary);
  const durationLabel =
    !activelyStreaming && item.duration_ms != null
      ? formatDurationMs(item.duration_ms)
      : null;
  const hasBody = item.content.trim().length > 0;
  const showPreview = !isOpen && collapsedLines > 0 && hasBody;

  return (
    <View style={[styles.container, nested ? styles.containerNested : null]}>
      <Pressable
        style={styles.header}
        onPress={hasBody ? () => setOpenOverride(!isOpen) : undefined}
        disabled={!hasBody}
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen, disabled: !hasBody }}
        accessibilityLabel={`Reasoning: ${label}${durationLabel ? `, duration ${durationLabel}` : ""}`}
        accessibilityHint={
          hasBody
            ? isOpen
              ? "Hides the full thought"
              : "Shows the full thought"
            : undefined
        }
        accessibilityLiveRegion={
          lifecycle === "error"
            ? "assertive"
            : lifecycle === "interrupted"
              ? "polite"
              : "none"
        }
      >
        {activelyStreaming ? (
          <ActivityDiamond
            size={theme.iconSize.xs}
            color={theme.colors.accent.default}
          />
        ) : lifecycle === "interrupted" ? (
          <PauseCircle
            accessible={false}
            size={theme.iconSize.xs}
            color={theme.colors.warning.default}
          />
        ) : lifecycle === "error" ? (
          <CircleX
            accessible={false}
            size={theme.iconSize.xs}
            color={theme.colors.danger.default}
          />
        ) : (
          <Brain
            accessible={false}
            size={theme.iconSize.xs}
            color={theme.colors.fg.faint}
          />
        )}
        <Text
          variant="label"
          color="muted"
          numberOfLines={1}
          style={styles.label}
        >
          {label}
        </Text>
        {durationLabel ? (
          <Text variant="caption" size="xs" color="faint">
            · {durationLabel}
          </Text>
        ) : null}
        {hasBody ? (
          <ChevronRight
            size={theme.iconSize.xs}
            style={isOpen ? styles.chevronOpen : undefined}
            color={theme.colors.fg.faint}
          />
        ) : null}
      </Pressable>

      {isOpen && hasBody ? (
        <View style={styles.body}>
          <MarkdownRenderer
            text={item.content}
            streaming={activelyStreaming}
            interpretDirectives={false}
          />
        </View>
      ) : null}

      {showPreview ? (
        <Pressable
          style={styles.body}
          onPress={() => setOpenOverride(true)}
          accessibilityRole="button"
        >
          <Text
            variant="body"
            size="sm"
            color="muted"
            numberOfLines={collapsedLines}
          >
            {item.content}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

/** Reads the shared reveal preference. Split out from ReasoningBlock so only
    reasoning rows subscribe to the session store, not every transcript row. */
export const ConnectedReasoningBlock = memo(function ConnectedReasoningBlock({
  item,
  nested,
}: {
  item: ReasoningItem;
  nested?: boolean;
}) {
  const display = useThinkingDisplay();
  return <ReasoningBlock item={item} display={display} nested={nested} />;
});

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border.emphasis,
    paddingLeft: theme.spacing[3],
  },
  containerNested: {
    marginHorizontal: 0,
    borderLeftWidth: 0,
    paddingLeft: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // The painted row is short; keep the tap target at the HIG minimum.
    minHeight: theme.minTouchTarget,
  },
  label: {
    flex: 1,
  },
  chevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  body: {
    paddingBottom: theme.spacing[2],
  },
}));
