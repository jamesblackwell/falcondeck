import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight, ExternalLink, Search } from "lucide-react-native";

import {
  contentLifecycle,
  safeExternalUrl,
  webSearchActionLabel,
  type ConversationItem,
} from "@falcondeck/client-core";

import { ActivityDiamond, Text } from "@/components/ui";
import { useExternalUrl } from "./useExternalUrl";

type WebSearchItem = Extract<ConversationItem, { kind: "web_search" }>;

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const WebSearchBlock = memo(function WebSearchBlock({
  item,
}: {
  item: WebSearchItem;
}) {
  const { theme } = useUnistyles();
  const lifecycle = contentLifecycle(item);
  const [queriesExpanded, setQueriesExpanded] = useState(false);
  const active = lifecycle === "pending" || lifecycle === "streaming";
  const url = safeExternalUrl(item.search.url);
  const externalUrl = useExternalUrl(url ?? "");
  const query =
    item.search.query.trim() ||
    item.search.queries[0]?.trim() ||
    "Web research";
  const actionLabel = webSearchActionLabel(item.search.action_kind, active);

  return (
    <View style={styles.container}>
      <View
        style={styles.icon}
        accessible={active}
        accessibilityLabel={active ? `${actionLabel}, in progress` : undefined}
        accessibilityState={active ? { busy: true } : undefined}
      >
        {active ? (
          <ActivityDiamond
            size={theme.iconSize.sm}
            color={theme.colors.accent.default}
          />
        ) : (
          <Search
            accessible={false}
            size={theme.iconSize.sm}
            color={theme.colors.fg.muted}
          />
        )}
      </View>
      <View style={styles.content}>
        <Text variant="caption" size="xs" color="faint">
          {actionLabel}
        </Text>
        <Text variant="body" size="sm" color="primary" selectable>
          {query}
        </Text>
        {item.search.pattern ? (
          <Text
            selectable
            variant="mono"
            size="xs"
            color="muted"
            numberOfLines={1}
          >
            Find: {item.search.pattern}
          </Text>
        ) : null}
        {url ? (
          <Pressable
            onPress={() => {
              void externalUrl.open();
            }}
            accessibilityRole="link"
            accessibilityLabel={`Open source page on ${hostname(url)}`}
            accessibilityHint={
              externalUrl.opening
                ? "Opening this source page in your browser"
                : externalUrl.failed
                  ? "Retries opening this source page in your browser"
                  : "Opens this source page in your browser"
            }
            accessibilityState={{ busy: externalUrl.opening }}
            style={styles.link}
          >
            <Text
              variant="caption"
              color="accent"
              numberOfLines={1}
              style={styles.linkLabel}
            >
              {hostname(url)}
            </Text>
            <ExternalLink
              accessible={false}
              size={theme.iconSize.xs}
              color={theme.colors.accent.default}
            />
          </Pressable>
        ) : null}
        {url && externalUrl.failed ? (
          <Text
            variant="caption"
            size="2xs"
            color="danger"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            Could not open source page. Tap to retry.
          </Text>
        ) : null}
        {item.search.queries.length > 1 ? (
          <>
            <Pressable
              onPress={() => setQueriesExpanded((expanded) => !expanded)}
              accessibilityRole="button"
              accessibilityLabel={`${item.search.queries.length} related queries`}
              accessibilityHint={
                queriesExpanded
                  ? "Collapses related queries"
                  : "Expands related queries"
              }
              accessibilityState={{ expanded: queriesExpanded }}
              style={styles.queryToggle}
            >
              <ChevronRight
                accessible={false}
                size={theme.iconSize.xs}
                color={theme.colors.fg.muted}
                style={
                  queriesExpanded ? styles.queryChevronExpanded : undefined
                }
              />
              <Text variant="caption" size="xs" color="muted">
                {item.search.queries.length} related queries
              </Text>
            </Pressable>
            {queriesExpanded ? (
              <View style={styles.queryList}>
                {item.search.queries.map((relatedQuery, index) => (
                  <Text
                    key={`${item.search.id}-query-${index}`}
                    variant="caption"
                    size="xs"
                    color="muted"
                    selectable
                  >
                    • {relatedQuery}
                  </Text>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </View>
      {lifecycle === "interrupted" ? (
        <Text
          variant="caption"
          size="xs"
          color="warning"
          accessibilityRole="text"
          accessibilityLiveRegion="polite"
        >
          Interrupted
        </Text>
      ) : lifecycle === "error" ? (
        <Text
          variant="caption"
          size="xs"
          color="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          Failed
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[1],
  },
  icon: {
    paddingTop: 2,
  },
  content: {
    flex: 1,
    gap: theme.spacing[1],
  },
  link: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
  },
  linkLabel: {
    flexShrink: 1,
  },
  queryToggle: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
  },
  queryChevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  queryList: {
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[3],
  },
}));
