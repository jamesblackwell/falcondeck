import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  BookOpen,
  ChevronRight,
  CircleX,
  ExternalLink,
  FileText,
  PauseCircle,
} from "lucide-react-native";

import {
  CITATION_PAGE_SIZE,
  MEMORY_CITATION_NOTE_MAX_CHARS,
  MEMORY_CITATION_PATH_MAX_CHARS,
  citationDisplayLabel,
  citationExternalUrl,
  citationExcerptPreview,
  citationLocatorLabel,
  citationRenderKeys,
  citationTextPreview,
  contentLifecycle,
  assistantFailureDetail,
  type ConversationCitation,
  type ConversationItem,
  type ConversationMemoryCitation,
} from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageActions } from "./MessageActions";
import { useExternalUrl } from "./useExternalUrl";

type AssistantMessage = Extract<
  ConversationItem,
  { kind: "assistant_message" }
>;

interface AssistantMessageBlockProps {
  item: AssistantMessage;
  retrySource?: Extract<ConversationItem, { kind: "user_message" }> | null;
  onRetryResponse?: (
    item: Extract<ConversationItem, { kind: "user_message" }>,
  ) => void;
}

const CitationLink = memo(function CitationLink({
  url,
  label,
}: {
  url: string;
  label: string;
}) {
  const { theme } = useUnistyles();
  const { failed, opening, open } = useExternalUrl(url);
  return (
    <View style={styles.citationLinkContainer}>
      <Pressable
        onPress={() => {
          void open();
        }}
        accessibilityRole="link"
        accessibilityLabel={`Open cited source: ${label}`}
        accessibilityHint={
          opening
            ? "Opening this source in your browser"
            : failed
              ? "Retries opening this source in your browser"
              : "Opens this source in your browser"
        }
        accessibilityState={{ busy: opening }}
        style={styles.citationLink}
      >
        <Text
          variant="caption"
          size="xs"
          color="accent"
          numberOfLines={2}
          style={styles.citationPath}
        >
          {label}
        </Text>
        <ExternalLink
          accessible={false}
          size={theme.iconSize.xs}
          color={theme.colors.accent.default}
        />
      </Pressable>
      {failed ? (
        <Text
          variant="caption"
          size="2xs"
          color="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          Could not open source. Tap to retry.
        </Text>
      ) : null}
    </View>
  );
});

const CitationBlock = memo(function CitationBlock({
  citations,
}: {
  citations: ConversationCitation[];
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(CITATION_PAGE_SIZE);

  if (citations.length === 0) return null;
  const visibleCitations = expanded ? citations.slice(0, visibleCount) : [];
  const citationKeys = citationRenderKeys(visibleCitations);
  const remaining = Math.max(0, citations.length - visibleCitations.length);

  return (
    <View style={styles.citationContainer}>
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={`${citations.length} cited source${citations.length === 1 ? "" : "s"}`}
        accessibilityHint={
          expanded ? "Collapses cited sources" : "Expands cited sources"
        }
        accessibilityState={{ expanded }}
        style={styles.citationHeader}
      >
        <BookOpen
          accessible={false}
          size={theme.iconSize.xs}
          color={theme.colors.fg.muted}
        />
        <Text
          variant="caption"
          size="xs"
          color="muted"
          style={styles.citationTitle}
        >
          {citations.length} cited source{citations.length === 1 ? "" : "s"}
        </Text>
        <ChevronRight
          accessible={false}
          size={theme.iconSize.xs}
          color={theme.colors.fg.faint}
          style={expanded ? styles.citationChevronExpanded : undefined}
        />
      </Pressable>
      {expanded ? (
        <View style={styles.citationList}>
          {visibleCitations.map((citation, index) => {
            const url = citationExternalUrl(citation);
            const label = citationDisplayLabel(citation, index);
            const locatorLabel = citationLocatorLabel(citation.locator);
            const excerpt = citationExcerptPreview(citation);
            return (
              <View key={citationKeys[index]} style={styles.citationEntry}>
                <View
                  accessible={!url}
                  accessibilityRole={!url ? "text" : undefined}
                  accessibilityLabel={
                    !url
                      ? `Source ${index + 1}: ${label.text}${locatorLabel ? `, ${locatorLabel}` : ""}`
                      : undefined
                  }
                  style={styles.citationPathRow}
                >
                  <View style={styles.citationIndex} accessible={false}>
                    <Text variant="mono" size="2xs" color="muted">
                      {index + 1}
                    </Text>
                  </View>
                  <View style={styles.citationPath}>
                    {url ? (
                      <CitationLink url={url} label={label.text} />
                    ) : (
                      <Text
                        selectable
                        variant="caption"
                        size="xs"
                        color="secondary"
                        numberOfLines={2}
                      >
                        {label.text}
                      </Text>
                    )}
                    {locatorLabel ? (
                      <Text selectable variant="mono" size="2xs" color="muted">
                        {locatorLabel}
                      </Text>
                    ) : null}
                  </View>
                </View>
                {excerpt ? (
                  <View style={styles.citationQuoteContainer}>
                    <Text
                      variant="caption"
                      size="xs"
                      color="muted"
                      selectable
                      style={styles.citationQuoteWithIndex}
                    >
                      “{excerpt.text}”
                    </Text>
                    {excerpt.limited ? (
                      <Text
                        variant="caption"
                        size="2xs"
                        color="muted"
                        style={styles.citationLimitNotice}
                      >
                        Excerpt limited for performance.
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
          {remaining > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${Math.min(CITATION_PAGE_SIZE, remaining)} more cited sources`}
              onPress={() =>
                setVisibleCount((count) => count + CITATION_PAGE_SIZE)
              }
              style={styles.showMoreSources}
            >
              <Text
                variant="caption"
                size="xs"
                color="accent"
                weight="semibold"
              >
                Show {Math.min(CITATION_PAGE_SIZE, remaining)} more
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const MemoryCitationBlock = memo(function MemoryCitationBlock({
  citation,
}: {
  citation: ConversationMemoryCitation;
}) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(CITATION_PAGE_SIZE);
  const count = citation.entries.length;
  const visibleEntries = expanded
    ? citation.entries.slice(0, visibleCount)
    : [];
  const remaining = Math.max(0, count - visibleEntries.length);

  if (count === 0) return null;

  return (
    <View style={styles.citationContainer}>
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={`${count} memory source${count === 1 ? "" : "s"}`}
        accessibilityHint={
          expanded ? "Collapses memory sources" : "Expands memory sources"
        }
        accessibilityState={{ expanded }}
        style={styles.citationHeader}
      >
        <BookOpen
          accessible={false}
          size={theme.iconSize.xs}
          color={theme.colors.fg.muted}
        />
        <Text
          variant="caption"
          size="xs"
          color="muted"
          style={styles.citationTitle}
        >
          {count} memory source{count === 1 ? "" : "s"}
        </Text>
        {citation.thread_ids.length > 0 ? (
          <Text variant="meta" size="2xs">
            {citation.thread_ids.length} thread
            {citation.thread_ids.length === 1 ? "" : "s"}
          </Text>
        ) : null}
        <ChevronRight
          accessible={false}
          size={theme.iconSize.xs}
          color={theme.colors.fg.faint}
          style={expanded ? styles.citationChevronExpanded : undefined}
        />
      </Pressable>
      {expanded ? (
        <View style={styles.citationList}>
          {visibleEntries.map((entry, index) => {
            const path = citationTextPreview(
              entry.path,
              MEMORY_CITATION_PATH_MAX_CHARS,
            );
            const note = citationTextPreview(
              entry.note,
              MEMORY_CITATION_NOTE_MAX_CHARS,
            );
            return (
              <View
                key={`${entry.path}-${entry.line_start}-${entry.line_end}-${index}`}
                style={styles.citationEntry}
              >
                <View style={styles.citationPathRow}>
                  <FileText
                    accessible={false}
                    size={theme.iconSize.xs}
                    color={theme.colors.fg.faint}
                  />
                  <Text
                    variant="mono"
                    size="xs"
                    color="secondary"
                    numberOfLines={1}
                    selectable
                    style={styles.citationPath}
                  >
                    {path.text}:{entry.line_start}
                    {entry.line_end !== entry.line_start
                      ? `–${entry.line_end}`
                      : ""}
                  </Text>
                </View>
                {note.text ? (
                  <Text
                    variant="caption"
                    size="xs"
                    color="muted"
                    selectable
                    style={styles.citationNote}
                  >
                    {note.text}
                  </Text>
                ) : null}
                {path.limited || note.limited ? (
                  <Text
                    variant="caption"
                    size="2xs"
                    color="muted"
                    style={styles.citationNote}
                  >
                    Source details limited for performance.
                  </Text>
                ) : null}
              </View>
            );
          })}
          {remaining > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${Math.min(CITATION_PAGE_SIZE, remaining)} more memory sources`}
              onPress={() =>
                setVisibleCount((value) => value + CITATION_PAGE_SIZE)
              }
              style={styles.showMoreSources}
            >
              <Text
                variant="caption"
                size="xs"
                color="accent"
                weight="semibold"
              >
                Show {Math.min(CITATION_PAGE_SIZE, remaining)} more
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

export const AssistantMessageBlock = memo(function AssistantMessageBlock({
  item,
}: AssistantMessageBlockProps) {
  const { theme } = useUnistyles();
  const lifecycle = contentLifecycle(item);
  const isCommentary = item.phase === "commentary";
  const failureDetail =
    lifecycle === "error" ? assistantFailureDetail(item) : null;

  return (
    <View style={[styles.row, isCommentary ? styles.commentaryRow : undefined]}>
      {isCommentary ? (
        <Text variant="meta" size="2xs" weight="medium">
          PROGRESS UPDATE
        </Text>
      ) : null}
      {lifecycle === "pending" && !item.text ? (
        <Text variant="caption" color="muted">
          Preparing response…
        </Text>
      ) : null}
      <MarkdownRenderer
        text={item.text}
        streaming={lifecycle === "pending" || lifecycle === "streaming"}
      />
      {item.citations?.length ? (
        <CitationBlock citations={item.citations} />
      ) : null}
      {item.memory_citation ? (
        <MemoryCitationBlock citation={item.memory_citation} />
      ) : null}
      <View style={styles.actions} accessible={false}>
        {lifecycle === "complete" && item.text.trim() ? (
          <MessageActions text={item.text} readAloudKey={item.id} />
        ) : null}
        {lifecycle === "interrupted" ? (
          <View
            style={styles.status}
            accessible
            accessibilityLabel="Response interrupted"
            accessibilityLiveRegion="polite"
          >
            <PauseCircle
              accessible={false}
              size={theme.iconSize.xs}
              color={theme.colors.warning.default}
            />
            <Text variant="caption" size="xs" color="warning">
              Response interrupted
            </Text>
          </View>
        ) : lifecycle === "error" ? (
          <View
            style={styles.status}
            accessible
            accessibilityRole="alert"
            accessibilityLabel={
              failureDetail
                ? `Response failed. ${failureDetail}`
                : "Response failed"
            }
            accessibilityLiveRegion="assertive"
          >
            <CircleX
              accessible={false}
              size={theme.iconSize.xs}
              color={theme.colors.danger.default}
            />
            <View style={styles.failureCopy}>
              <Text variant="caption" size="xs" color="danger">
                Response failed
              </Text>
              {failureDetail ? (
                <Text variant="caption" size="sm" color="danger">
                  {failureDetail}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
  },
  commentaryRow: {
    marginHorizontal: theme.spacing[4],
    paddingHorizontal: 0,
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border.subtle,
  },
  actions: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  status: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  failureCopy: {
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  citationContainer: {
    marginTop: theme.spacing[2],
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    borderRadius: theme.radius.md,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[1],
  },
  citationHeader: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  citationTitle: {
    flex: 1,
  },
  citationChevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  citationList: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
  },
  citationEntry: {
    gap: theme.spacing[1],
  },
  citationPathRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1],
  },
  citationIndex: {
    minWidth: theme.spacing[5],
    height: theme.spacing[5],
    paddingHorizontal: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface[3],
  },
  citationLink: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  citationLinkContainer: {
    flex: 1,
  },
  citationPath: {
    flex: 1,
  },
  citationNote: {
    paddingLeft: theme.spacing[5],
  },
  citationQuote: {
    paddingLeft: theme.spacing[2],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border.subtle,
  },
  citationQuoteWithIndex: {
    marginLeft: theme.spacing[6],
    paddingLeft: theme.spacing[2],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border.subtle,
  },
  citationQuoteContainer: {
    gap: theme.spacing[1],
  },
  citationLimitNotice: {
    marginLeft: theme.spacing[6],
  },
  showMoreSources: {
    minHeight: theme.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
  },
}));
