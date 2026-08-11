import { memo, useState } from "react";
import { Pressable, View } from "react-native";
import { ChevronRight, ExternalLink, FileText } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  contentLifecycle,
  contentLifecycleLabel,
  isSafeExternalUrl,
  providerOutputKindLabel,
  type ConversationItem,
} from "@falcondeck/client-core";

import { ActivityDiamond, Text } from "@/components/ui";
import { ArtifactShareButton } from "./ArtifactShareButton";
import { CodeBlock } from "./CodeBlock";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { TechnicalPayloadDetail } from "./TechnicalPayloadDetail";
import { useExternalUrl } from "./useExternalUrl";

type ArtifactItem = Extract<ConversationItem, { kind: "artifact" }>;

export const ArtifactBlock = memo(function ArtifactBlock({
  item,
}: {
  item: ArtifactItem;
}) {
  const { theme } = useUnistyles();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const lifecycle = contentLifecycle(item);
  const active = lifecycle === "pending" || lifecycle === "streaming";
  const artifact = item.artifact;
  const url = artifact.url?.trim() ?? "";
  const safeUrl = isSafeExternalUrl(url) ? url : "";
  const externalUrl = useExternalUrl(safeUrl);
  const markdown =
    artifact.mime_type?.toLowerCase().includes("markdown") ||
    /\.md(?:own)?$/i.test(artifact.title);

  return (
    <View
      style={[styles.container, lifecycle === "error" && styles.errorContainer]}
      accessibilityLabel={`${artifact.title}. Artifact. ${contentLifecycleLabel(lifecycle)}`}
      accessibilityState={{ busy: active }}
    >
      <View style={styles.header}>
        {active ? (
          <ActivityDiamond
            size={theme.iconSize.sm}
            color={theme.colors.accent.default}
          />
        ) : (
          <FileText
            accessible={false}
            size={theme.iconSize.sm}
            color={theme.colors.accent.default}
          />
        )}
        <View style={styles.headerCopy}>
          <Text
            selectable
            variant="body"
            size="sm"
            color="primary"
            weight="medium"
            numberOfLines={2}
          >
            {artifact.title}
          </Text>
          <Text
            variant="caption"
            size="2xs"
            color={lifecycle === "error" ? "danger" : "muted"}
          >
            {[
              providerOutputKindLabel(artifact.artifact_kind),
              artifact.mime_type,
              artifact.version ? `Version ${artifact.version}` : null,
              contentLifecycleLabel(lifecycle),
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        {safeUrl ? (
          <Pressable
            onPress={() => {
              void externalUrl.open();
            }}
            accessibilityRole="link"
            accessibilityLabel={`Open artifact: ${artifact.title}`}
            accessibilityHint={
              externalUrl.opening
                ? "Opening this artifact in your browser"
                : externalUrl.failed
                  ? "Retries opening this artifact in your browser"
                  : "Opens this artifact in your browser"
            }
            accessibilityState={{ busy: externalUrl.opening }}
            style={styles.openButton}
          >
            <Text variant="caption" size="xs" color="accent">
              Open
            </Text>
            <ExternalLink
              accessible={false}
              size={theme.iconSize.xs}
              color={theme.colors.accent.default}
            />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.body}>
        {artifact.content ? (
          markdown ? (
            <MarkdownRenderer
              text={artifact.content}
              streaming={active}
              interpretDirectives={false}
            />
          ) : (
            <CodeBlock
              code={artifact.content}
              language={artifact.mime_type?.split("/").at(-1)}
              previewLines={20}
            />
          )
        ) : (
          <Text selectable variant="caption" size="xs" color="secondary">
            {active
              ? "Preparing artifact…"
              : lifecycle === "error"
                ? "The provider could not finish this artifact."
                : "The provider supplied artifact metadata without an inline preview."}
          </Text>
        )}
        {url && !safeUrl ? (
          <Text selectable variant="mono" size="2xs" color="muted">
            Reference: {url}
          </Text>
        ) : null}
        {safeUrl && externalUrl.failed ? (
          <Text
            variant="caption"
            size="2xs"
            color="danger"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            Could not open artifact. Tap Open to retry.
          </Text>
        ) : null}
        {artifact.content && !active ? (
          <ArtifactShareButton
            filename={artifact.title}
            mimeType={artifact.mime_type}
            text={artifact.content}
          />
        ) : null}
        <Pressable
          onPress={() => setDetailsOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel="Artifact technical details"
          accessibilityHint={
            detailsOpen
              ? "Collapses provider artifact details"
              : "Expands provider artifact details"
          }
          accessibilityState={{ expanded: detailsOpen }}
          style={styles.detailsToggle}
        >
          <ChevronRight
            accessible={false}
            size={theme.iconSize.xs}
            color={theme.colors.fg.muted}
            style={detailsOpen ? styles.chevronExpanded : undefined}
          />
          <Text variant="caption" size="xs" color="muted">
            Technical details
          </Text>
        </Pressable>
        {detailsOpen ? (
          <View style={styles.details}>
            <TechnicalPayloadDetail payload={artifact.payload} />
          </View>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface[2],
    borderColor: theme.colors.border.subtle,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    overflow: "hidden",
  },
  errorContainer: {
    borderColor: theme.colors.danger.default,
  },
  header: {
    alignItems: "center",
    borderBottomColor: theme.colors.border.subtle,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: theme.spacing[2],
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  headerCopy: {
    flex: 1,
    gap: theme.spacing[0.5],
  },
  openButton: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[1],
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[2],
  },
  body: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  detailsToggle: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[1],
    minHeight: theme.minTouchTarget,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  details: {
    backgroundColor: theme.colors.surface[1],
    borderRadius: theme.radius.md,
    gap: theme.spacing[1],
    padding: theme.spacing[3],
  },
}));
