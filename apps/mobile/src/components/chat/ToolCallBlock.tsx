import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import {
  Ban,
  ChevronRight,
  CheckCircle2,
  Circle,
  CircleX,
  Clock3,
  GitCommitHorizontal,
  Pause,
  PauseCircle,
  Play,
  Split,
  Upload,
} from "lucide-react-native";

import {
  isSafeExternalUrl,
  isSafeMediaUrl,
  formatArtifactSize,
  formatDurationMs,
  formatInspectableValue,
  guardianReviewPresentation,
  inspectableValueSummary,
  mcpTextDuplicatesStructuredContent,
  parseMcpResult,
  summarizeMcpArtifacts,
  summarizeParsedMcpArtifacts,
  notableToolAction,
  toolCallLabel,
  toolLifecycle,
  toolLifecycleLabel,
  type ConversationItem,
  type ToolTestSummary,
} from "@falcondeck/client-core";

import { ActivityDiamond, Text } from "@/components/ui";
import { mediaAudioPlayer } from "@/lib/media-audio-player";
import { ArtifactShareButton } from "./ArtifactShareButton";
import { CodeBlock } from "./CodeBlock";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { useCollapsible } from "./useCollapsible";
import { useExternalUrl } from "./useExternalUrl";

type ToolCall = Extract<ConversationItem, { kind: "tool_call" }>;

interface ToolCallBlockProps {
  item: ToolCall;
  defaultOpen: boolean;
  suppressDetail: boolean;
  variant?: "card" | "row";
  /** Set when the card renders inside a work session, which owns the inset. */
  nested?: boolean;
}

export const ToolCallBlock = memo(function ToolCallBlock({
  item,
  defaultOpen,
  suppressDetail,
  variant = "card",
  nested = false,
}: ToolCallBlockProps) {
  const { theme } = useUnistyles();
  const lifecycle = toolLifecycle(item);
  const awaitingApproval = lifecycle === "awaiting_approval";
  const { chevronStyle, isOpen, toggle } = useCollapsible(defaultOpen, item.id);

  const lifecycleLabel = toolLifecycleLabel(lifecycle);
  const commandDetail =
    item.detail?.kind === "command_execution" ? item.detail : null;
  const mcpDetail = item.detail?.kind === "mcp" ? item.detail : null;
  const artifactSummary = useMemo(
    () =>
      summarizeMcpArtifacts(
        mcpDetail?.result,
        item.display.provider_output_summary,
      ),
    [mcpDetail?.result, item.display.provider_output_summary],
  );
  const dynamicDetail = item.detail?.kind === "dynamic" ? item.detail : null;
  const collabDetail =
    item.detail?.kind === "collab_agent" ? item.detail : null;
  const subagentDetail =
    item.detail?.kind === "subagent_activity" ? item.detail : null;
  const hookDetail = item.detail?.kind === "hook" ? item.detail : null;
  const guardianDetail =
    item.detail?.kind === "guardian_review" ? item.detail : null;
  const testSummary = item.display.test_summary ?? null;
  const hasStructuredDetail = Boolean(
    mcpDetail ||
    dynamicDetail ||
    collabDetail ||
    subagentDetail ||
    hookDetail ||
    guardianDetail ||
    testSummary ||
    (commandDetail &&
      (commandDetail.cwd ||
        commandDetail.actions.length > 0 ||
        commandDetail.duration_ms != null ||
        commandDetail.process_id ||
        commandDetail.source)),
  );
  const statusIcon = (() => {
    switch (lifecycle) {
      case "running":
        return (
          <ActivityDiamond size={14} color={theme.colors.accent.default} />
        );
      case "succeeded":
        return (
          <CheckCircle2
            accessible={false}
            size={14}
            color={theme.colors.success.default}
          />
        );
      case "failed":
        return (
          <CircleX
            accessible={false}
            size={14}
            color={theme.colors.danger.default}
          />
        );
      case "denied":
        return (
          <Ban
            accessible={false}
            size={14}
            color={theme.colors.danger.default}
          />
        );
      case "interrupted":
        return (
          <PauseCircle
            accessible={false}
            size={14}
            color={theme.colors.warning.default}
          />
        );
      case "awaiting_approval":
        return (
          <Clock3
            accessible={false}
            size={14}
            color={theme.colors.warning.default}
          />
        );
      case "queued":
        return (
          <Clock3 accessible={false} size={14} color={theme.colors.fg.faint} />
        );
      default:
        return (
          <Circle accessible={false} size={14} color={theme.colors.fg.faint} />
        );
    }
  })();

  const hasContent =
    (Boolean(item.output) || hasStructuredDetail) && !suppressDetail;
  const testBadgeLabel = testSummary ? testSummaryHeadline(testSummary) : null;
  const label = useMemo(
    () => toolCallLabel(item),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- title, detail, kind and the head of the output are all toolCallLabel reads.
    [item.title, item.output, item.detail, item.tool_kind],
  );
  const notable = notableToolAction(item);
  const notableColor =
    notable?.kind === "push"
      ? theme.colors.info.default
      : notable
        ? theme.colors.accent.default
        : null;
  const NotableIcon =
    notable?.kind === "commit"
      ? GitCommitHorizontal
      : notable?.kind === "push"
        ? Upload
        : notable?.kind === "breakout"
          ? Split
          : null;

  if (variant === "row") {
    return (
      <View
        style={styles.rowHeader}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${label}, ${lifecycleLabel}${testBadgeLabel ? `, ${testBadgeLabel}` : ""}`}
      >
        {statusIcon}
        {NotableIcon && notableColor ? (
          <NotableIcon accessible={false} size={14} color={notableColor} />
        ) : null}
        <Text
          variant="mono"
          color="tertiary"
          size="xs"
          style={[styles.title, notableColor ? { color: notableColor } : null]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        nested ? styles.containerNested : null,
        notableColor
          ? {
              borderColor: notableColor,
              backgroundColor:
                notable?.kind === "push"
                  ? theme.colors.info.muted
                  : theme.colors.accent.muted,
            }
          : null,
      ]}
    >
      <Pressable
        style={styles.header}
        onPress={hasContent && !awaitingApproval ? toggle : undefined}
        disabled={awaitingApproval}
        accessibilityRole={hasContent ? "button" : undefined}
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${label}, ${lifecycleLabel}${testBadgeLabel ? `, ${testBadgeLabel}` : ""}`}
        accessibilityHint={
          hasContent
            ? awaitingApproval
              ? "Approval context stays expanded until the request is resolved"
              : isOpen
                ? "Collapses tool output"
                : "Expands tool output"
            : undefined
        }
        accessibilityState={
          hasContent
            ? {
                expanded: awaitingApproval || isOpen,
                disabled: awaitingApproval,
              }
            : undefined
        }
      >
        {statusIcon}
        {NotableIcon && notableColor ? (
          <NotableIcon accessible={false} size={14} color={notableColor} />
        ) : null}
        <Text
          variant="mono"
          color="tertiary"
          size="xs"
          style={[styles.title, notableColor ? { color: notableColor } : null]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {awaitingApproval ? (
          <Text variant="caption" color="warning" size="2xs" weight="semibold">
            Awaiting approval
          </Text>
        ) : (
          <>
            {testSummary ? (
              <View
                style={[
                  (testSummary.failed ?? 0) > 0
                    ? styles.testBadgeFailed
                    : styles.testBadgePassed,
                  styles.testBadge,
                ]}
              >
                <Text
                  variant="caption"
                  color={(testSummary.failed ?? 0) > 0 ? "danger" : "success"}
                  size="2xs"
                  weight="semibold"
                >
                  {testBadgeLabel}
                </Text>
              </View>
            ) : null}
            {artifactSummary.total > 0 ? (
              <View style={styles.artifactBadge}>
                <Text
                  variant="caption"
                  color="accent"
                  size="2xs"
                  weight="semibold"
                >
                  {artifactSummary.total} artifact
                  {artifactSummary.total === 1 ? "" : "s"}
                </Text>
              </View>
            ) : null}
            {hasContent ? (
              <Animated.View style={chevronStyle}>
                <ChevronRight size={14} color={theme.colors.fg.muted} />
              </Animated.View>
            ) : null}
          </>
        )}
      </Pressable>
      {hasContent && awaitingApproval ? (
        <View style={styles.body}>
          <ToolDetailBody item={item} />
        </View>
      ) : hasContent && isOpen ? (
        <View style={styles.body}>
          <ToolDetailBody item={item} />
        </View>
      ) : null}
    </View>
  );
});

function ToolDetailBody({ item }: { item: ToolCall }) {
  const detail = item.detail;
  const structuredHasText =
    (detail?.kind === "dynamic" &&
      detail.content_items.some((content) => content.kind === "text")) ||
    (detail?.kind === "mcp" &&
      parseMcpResult(detail.result).content.some(
        (content) => content.kind === "text",
      ));
  return (
    <>
      {item.display.test_summary ? (
        <TestRunSummary summary={item.display.test_summary} />
      ) : null}
      {detail?.kind === "command_execution" ? (
        <CommandDetail detail={detail} />
      ) : null}
      {detail?.kind === "mcp" ? (
        <McpDetail detail={detail} itemId={item.id} />
      ) : null}
      {detail?.kind === "dynamic" ? (
        <DynamicDetail detail={detail} itemId={item.id} />
      ) : null}
      {detail?.kind === "collab_agent" ? (
        <CollabDetail detail={detail} />
      ) : null}
      {detail?.kind === "subagent_activity" ? (
        <SubagentActivityDetail detail={detail} />
      ) : null}
      {detail?.kind === "hook" ? <HookDetail detail={detail} /> : null}
      {detail?.kind === "guardian_review" ? (
        <GuardianReviewDetail detail={detail} />
      ) : null}
      {item.output && !structuredHasText ? (
        <CodeBlock code={item.output} />
      ) : null}
    </>
  );
}

function testSummaryHeadline(summary: ToolTestSummary) {
  if ((summary.failed ?? 0) > 0) return `${summary.failed} failed`;
  if (summary.passed != null) return `${summary.passed} passed`;
  if (summary.total != null)
    return `${summary.total} test${summary.total === 1 ? "" : "s"}`;
  return summary.framework
    ? agentStatusLabel(summary.framework)
    : "Test results";
}

function TestRunSummary({ summary }: { summary: ToolTestSummary }) {
  const facts = [
    summary.passed != null ? `${summary.passed} passed` : null,
    summary.failed != null ? `${summary.failed} failed` : null,
    summary.skipped != null ? `${summary.skipped} skipped` : null,
    summary.suites_passed != null
      ? `${summary.suites_passed} suite${summary.suites_passed === 1 ? "" : "s"} passed`
      : null,
    summary.suites_failed != null
      ? `${summary.suites_failed} suite${summary.suites_failed === 1 ? "" : "s"} failed`
      : null,
    summary.suites_passed == null &&
    summary.suites_failed == null &&
    summary.suites_total != null
      ? `${summary.suites_total} suite${summary.suites_total === 1 ? "" : "s"}`
      : null,
    summary.duration_ms != null ? formatDurationMs(summary.duration_ms) : null,
  ].filter((fact): fact is string => fact != null);
  const label = [
    "Test results",
    summary.framework ? agentStatusLabel(summary.framework) : null,
    ...facts,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <View
      style={styles.commandDetail}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={label}
    >
      <Text variant="caption" color="secondary" size="2xs" weight="semibold">
        Test results
      </Text>
      <View style={styles.commandActions}>
        {summary.framework ? (
          <MetaChip label={agentStatusLabel(summary.framework)} />
        ) : null}
        {facts.map((fact) => (
          <MetaChip key={fact} label={fact} />
        ))}
      </View>
    </View>
  );
}

function CollabDetail({
  detail,
}: {
  detail: Extract<NonNullable<ToolCall["detail"]>, { kind: "collab_agent" }>;
}) {
  const states = Object.entries(detail.agent_states);
  return (
    <View style={styles.commandDetail}>
      <View style={styles.commandActions}>
        {detail.model ? <MetaChip label={detail.model} /> : null}
        {detail.reasoning_effort ? (
          <MetaChip label={`${detail.reasoning_effort} effort`} />
        ) : null}
        <MetaChip
          label={`${detail.receiver_thread_ids.length} ${detail.receiver_thread_ids.length === 1 ? "agent" : "agents"}`}
        />
      </View>
      {detail.prompt ? (
        <Text selectable variant="mono" color="muted" size="2xs">
          {detail.prompt}
        </Text>
      ) : null}
      {states.map(([threadId, state]) => (
        <View
          key={threadId}
          style={styles.agentState}
          accessible
          accessibilityLabel={`${agentStatusLabel(state.status)}, ${state.message || threadId}`}
        >
          <Text
            variant="caption"
            color="secondary"
            size="2xs"
            weight="semibold"
          >
            {agentStatusLabel(state.status)}
          </Text>
          <Text
            selectable
            variant="caption"
            color="muted"
            size="2xs"
            style={styles.agentStateMessage}
          >
            {state.message || compactThreadId(threadId)}
          </Text>
          {state.message ? (
            <Text selectable variant="mono" color="muted" size="2xs">
              {compactThreadId(threadId)}
            </Text>
          ) : null}
        </View>
      ))}
      {states.length === 0 && detail.receiver_thread_ids.length > 0 ? (
        <Text selectable variant="mono" color="muted" size="2xs">
          {detail.receiver_thread_ids.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

function SubagentActivityDetail({
  detail,
}: {
  detail: Extract<
    NonNullable<ToolCall["detail"]>,
    { kind: "subagent_activity" }
  >;
}) {
  return (
    <View
      style={styles.commandDetail}
      accessible
      accessibilityLabel={`${agentStatusLabel(detail.activity)}, ${detail.agent_path}, ${detail.agent_thread_id}`}
    >
      <Text variant="caption" color="secondary" size="2xs" weight="semibold">
        {agentStatusLabel(detail.activity)}
      </Text>
      <Text selectable variant="caption" color="muted" size="2xs">
        {detail.agent_path}
      </Text>
      <Text selectable variant="mono" color="muted" size="2xs">
        {compactThreadId(detail.agent_thread_id)}
      </Text>
    </View>
  );
}

function HookDetail({
  detail,
}: {
  detail: Extract<NonNullable<ToolCall["detail"]>, { kind: "hook" }>;
}) {
  return (
    <View style={styles.commandDetail}>
      <View style={styles.commandActions}>
        <MetaChip label={detail.handler_type} />
        <MetaChip label={detail.execution_mode} />
        <MetaChip label={detail.scope} />
        {detail.duration_ms != null ? (
          <MetaChip
            label={`${Math.max(1, Math.round(detail.duration_ms))} ms`}
          />
        ) : null}
      </View>
      <Text selectable variant="mono" color="muted" size="2xs">
        {detail.source_path}
      </Text>
      {detail.status_message ? (
        <Text selectable variant="caption" color="muted" size="2xs">
          {detail.status_message}
        </Text>
      ) : null}
      {detail.entries.map((entry, index) => {
        const urgent =
          entry.entry_kind === "warning" ||
          entry.entry_kind === "error" ||
          entry.entry_kind === "stop";
        return (
          <View
            key={`${entry.entry_kind}-${index}`}
            style={[styles.agentState, urgent ? styles.hookUrgent : null]}
            accessibilityRole={urgent ? "alert" : undefined}
            accessibilityLiveRegion={urgent ? "assertive" : "polite"}
          >
            <Text
              variant="caption"
              color={
                entry.entry_kind === "warning"
                  ? "warning"
                  : entry.entry_kind === "error" || entry.entry_kind === "stop"
                    ? "danger"
                    : "secondary"
              }
              size="2xs"
              weight="semibold"
            >
              {agentStatusLabel(entry.entry_kind)}
            </Text>
            <Text
              selectable
              variant="caption"
              color="muted"
              size="2xs"
              style={styles.agentStateMessage}
            >
              {entry.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function GuardianReviewDetail({
  detail,
}: {
  detail: Extract<NonNullable<ToolCall["detail"]>, { kind: "guardian_review" }>;
}) {
  const presentation = guardianReviewPresentation(detail);
  return (
    <View
      style={[
        styles.commandDetail,
        presentation.urgent ? styles.hookUrgent : null,
      ]}
      accessibilityRole={presentation.urgent ? "alert" : undefined}
      accessibilityLiveRegion={presentation.urgent ? "assertive" : "polite"}
    >
      <View style={styles.commandActions}>
        <MetaChip label={presentation.statusLabel} />
        <MetaChip label={`Action: ${presentation.actionKindLabel}`} />
        {detail.risk_level ? (
          <MetaChip label={`${agentStatusLabel(detail.risk_level)} risk`} />
        ) : null}
        {detail.user_authorization ? (
          <MetaChip
            label={`${agentStatusLabel(detail.user_authorization)} authorization`}
          />
        ) : null}
        {detail.duration_ms != null ? (
          <MetaChip
            label={`${Math.max(1, Math.round(detail.duration_ms))} ms`}
          />
        ) : null}
        {presentation.decisionSourceLabel ? (
          <MetaChip label={`Decision: ${presentation.decisionSourceLabel}`} />
        ) : null}
      </View>
      <Text selectable variant="mono" color="secondary" size="2xs">
        {detail.action}
      </Text>
      {detail.cwd ? (
        <Text selectable variant="mono" color="muted" size="2xs">
          cwd: {detail.cwd}
        </Text>
      ) : null}
      {detail.target_item_id ? (
        <Text selectable variant="mono" color="muted" size="2xs">
          target: {detail.target_item_id}
        </Text>
      ) : null}
      {detail.rationale ? (
        <View style={[styles.agentState, styles.reviewRationale]}>
          <Text
            variant="caption"
            color="secondary"
            size="2xs"
            weight="semibold"
          >
            Review rationale
          </Text>
          <Text
            selectable
            variant="caption"
            color="muted"
            size="2xs"
            style={styles.agentStateMessage}
          >
            {detail.rationale}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function MetaChip({ label }: { label: string }) {
  return (
    <View style={styles.commandAction}>
      <Text variant="caption" color="muted" size="2xs">
        {label}
      </Text>
    </View>
  );
}

function compactThreadId(threadId: string) {
  return threadId.length > 14 ? `…${threadId.slice(-10)}` : threadId;
}

function agentStatusLabel(status: string) {
  return status
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function CommandDetail({
  detail,
}: {
  detail: Extract<
    NonNullable<ToolCall["detail"]>,
    { kind: "command_execution" }
  >;
}) {
  return (
    <View style={styles.commandDetail}>
      <View style={styles.commandMeta}>
        {detail.cwd ? (
          <Text
            selectable
            variant="mono"
            color="muted"
            size="2xs"
            numberOfLines={1}
            style={styles.commandCwd}
          >
            cwd: {detail.cwd}
          </Text>
        ) : null}
        {detail.duration_ms != null ? (
          <Text variant="meta" size="2xs">
            {Math.max(1, Math.round(detail.duration_ms))} ms
          </Text>
        ) : null}
      </View>
      {detail.actions.length > 0 ? (
        <View style={styles.commandActions}>
          {detail.actions.map((action, index) => (
            <View
              key={`${action.action_kind}-${action.command}-${index}`}
              style={styles.commandAction}
            >
              <Text
                selectable
                variant="caption"
                color="muted"
                size="2xs"
                numberOfLines={1}
              >
                {action.action_kind
                  .replace(/([a-z])([A-Z])/g, "$1 $2")
                  .replace(/_/g, " ")}
                {action.path
                  ? ` · ${action.path.replaceAll("\\", "/").split("/").pop()}`
                  : ""}
                {action.query ? ` · ${action.query}` : ""}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function McpDetail({
  detail,
  itemId,
}: {
  detail: Extract<NonNullable<ToolCall["detail"]>, { kind: "mcp" }>;
  itemId: string;
}) {
  const result = parseMcpResult(detail.result);
  const artifactSummary = summarizeParsedMcpArtifacts(result);
  return (
    <View style={styles.commandDetail}>
      <View style={styles.commandMeta}>
        <Text variant="caption" color="muted" size="2xs">
          {detail.app_context?.app_name || detail.server} · {detail.tool}
        </Text>
        {detail.duration_ms != null ? (
          <Text variant="meta" size="2xs">
            {Math.max(1, Math.round(detail.duration_ms))} ms
          </Text>
        ) : null}
      </View>
      {detail.error ? (
        <Text selectable variant="caption" color="danger" size="2xs">
          {detail.error}
        </Text>
      ) : null}
      {artifactSummary.total > 0 ? (
        <View
          style={styles.artifactSectionHeader}
          accessible
          accessibilityLabel={`${artifactSummary.total} provider artifact${artifactSummary.total === 1 ? "" : "s"}`}
        >
          <Text variant="caption" color="secondary" size="xs" weight="semibold">
            Provider artifacts
          </Text>
          <Text variant="meta" size="2xs">
            {artifactSummary.total} item{artifactSummary.total === 1 ? "" : "s"}
          </Text>
        </View>
      ) : null}
      {result.content.map((content, index) => {
        if (content.kind === "text") {
          if (
            mcpTextDuplicatesStructuredContent(
              content.text,
              result.structured_content,
            )
          ) {
            return null;
          }
          return (
            <CodeBlock
              key={`text-${index}`}
              code={content.text}
              previewLines={12}
            />
          );
        }
        if (content.kind === "image") {
          return (
            <ProviderToolImage
              key={`image-${index}`}
              url={content.url}
              label={content.alt_text || `${detail.tool} output ${index + 1}`}
              fallbackValue={content}
            />
          );
        }
        if (content.kind === "resource_link") {
          return (
            <ProviderResourceLink key={`link-${index}`} content={content} />
          );
        }
        if (content.kind === "resource") {
          const filename = resourceFilename(content.uri, index);
          const size = formatArtifactSize(content.byte_size);
          return (
            <View key={`resource-${index}`} style={styles.resourceDetail}>
              <View style={styles.resourceHeader}>
                <View style={styles.resourceTitle}>
                  <Text
                    variant="caption"
                    color="secondary"
                    size="xs"
                    weight="semibold"
                    numberOfLines={1}
                  >
                    {filename}
                  </Text>
                  <Text variant="meta" size="2xs">
                    Embedded artifact
                    {content.mime_type ? ` · ${content.mime_type}` : ""}
                    {size ? ` · ${size}` : ""}
                  </Text>
                </View>
                {content.text != null || content.blob_url ? (
                  <ArtifactShareButton
                    filename={filename}
                    mimeType={content.mime_type}
                    text={content.text}
                    dataUrl={content.blob_url}
                    byteSize={content.byte_size}
                  />
                ) : null}
              </View>
              <Text selectable variant="mono" color="muted" size="2xs">
                {content.uri}
              </Text>
              {content.text != null ? (
                <ArtifactTextPreview
                  filename={filename}
                  mimeType={content.mime_type}
                  text={content.text}
                />
              ) : content.blob_url ? (
                <Text variant="caption" color="muted" size="2xs">
                  Binary content retained by the provider.
                </Text>
              ) : (
                <Text variant="caption" color="muted" size="2xs">
                  No readable content was supplied.
                </Text>
              )}
              {content.metadata != null ? (
                <JsonDetail
                  label="Resource metadata"
                  value={content.metadata}
                />
              ) : null}
            </View>
          );
        }
        const label =
          content.kind === "audio"
            ? `Audio output ${index + 1} · ${content.mime_type}`
            : `Provider output ${index + 1}`;
        if (content.kind === "audio" && isSafeMediaUrl(content.url, "audio")) {
          return (
            <AudioOutput
              key={`audio-${index}`}
              id={`${itemId}-audio-${index}`}
              label={label}
              url={content.url}
            />
          );
        }
        const fallbackValue =
          content.kind === "unknown" ? content.value : content;
        return (
          <JsonDetail
            key={`${content.kind}-${index}`}
            label={label}
            value={fallbackValue}
          />
        );
      })}
      {result.structured_content != null ? (
        <JsonDetail
          label="Structured result"
          value={result.structured_content}
        />
      ) : null}
      {result.extra != null ? (
        <JsonDetail label="Result metadata" value={result.extra} />
      ) : null}
      {result.metadata != null ? (
        <JsonDetail label="Provider metadata" value={result.metadata} />
      ) : null}
      <JsonDisclosure
        label="Arguments"
        value={detail.arguments}
        resetKey={itemId}
      />
    </View>
  );
}

type ProviderResourceLinkContent = Extract<
  ReturnType<typeof parseMcpResult>["content"][number],
  { kind: "resource_link" }
>;

function ProviderResourceLink({
  content,
}: {
  content: ProviderResourceLinkContent;
}) {
  const canOpen = isSafeExternalUrl(content.uri);
  const externalUrl = useExternalUrl(canOpen ? content.uri : "");
  const size = formatArtifactSize(content.size);
  const label = content.title || content.name;

  return (
    <View style={styles.resourceLinkContainer}>
      <Pressable
        style={styles.resourceDetail}
        accessibilityRole={canOpen ? "link" : undefined}
        accessibilityLabel={`Provider reference, ${label}${canOpen ? ", opens externally" : ""}`}
        accessibilityHint={
          canOpen
            ? externalUrl.opening
              ? "Opening the provider reference in your browser"
              : externalUrl.failed
                ? "Retries opening the provider reference in your browser"
                : "Opens the provider reference in your browser"
            : undefined
        }
        accessibilityState={canOpen ? { busy: externalUrl.opening } : undefined}
        onPress={
          canOpen
            ? () => {
                void externalUrl.open();
              }
            : undefined
        }
        disabled={!canOpen}
      >
        <View style={styles.resourceHeader}>
          <View style={styles.resourceTitle}>
            <Text
              variant="caption"
              color="secondary"
              size="xs"
              weight="semibold"
            >
              {label}
            </Text>
            <Text variant="meta" size="2xs">
              Reference{content.mime_type ? ` · ${content.mime_type}` : ""}
              {size ? ` · ${size}` : ""}
            </Text>
          </View>
          {canOpen ? (
            <Text variant="caption" color="accent" size="2xs" weight="semibold">
              OPEN
            </Text>
          ) : null}
        </View>
        {content.description ? (
          <Text variant="caption" color="muted" size="2xs">
            {content.description}
          </Text>
        ) : null}
        <Text variant="mono" color="muted" size="2xs">
          {content.uri}
        </Text>
      </Pressable>
      {canOpen && externalUrl.failed ? (
        <Text
          variant="caption"
          size="2xs"
          color="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          Could not open provider reference. Tap to retry.
        </Text>
      ) : null}
    </View>
  );
}

function ArtifactTextPreview({
  filename,
  mimeType,
  text,
}: {
  filename: string;
  mimeType: string | null;
  text: string;
}) {
  const normalizedMime = mimeType?.toLowerCase() ?? "";
  if (
    normalizedMime.includes("json") ||
    filename.toLowerCase().endsWith(".json")
  ) {
    let parsedJson: unknown;
    let hasValidJson = false;
    try {
      parsedJson = JSON.parse(text);
      hasValidJson = true;
    } catch {
      // Preserve malformed provider text below instead of hiding it.
    }
    if (hasValidJson) {
      return <JsonDetail label="Preview" value={parsedJson} />;
    }
  }
  if (
    normalizedMime === "text/markdown" ||
    normalizedMime === "text/x-markdown" ||
    /\.md(?:own)?$/i.test(filename)
  ) {
    return <MarkdownRenderer text={text} interpretDirectives={false} />;
  }
  const lines = text.split("\n");
  const truncated = lines.length > 40;
  return (
    <View style={styles.artifactTextPreview}>
      <Text
        variant="mono"
        color="muted"
        size="2xs"
        selectable
        numberOfLines={truncated ? 40 : undefined}
      >
        {text}
      </Text>
      {truncated ? (
        <Text variant="meta" size="2xs">
          Preview limited to 40 lines · Share to open the complete artifact.
        </Text>
      ) : null}
    </View>
  );
}

function resourceFilename(uri: string, index: number) {
  const raw = uri.split(/[?#]/, 1)[0]?.replace(/\/$/, "").split("/").at(-1);
  if (!raw) return `resource-${index + 1}`;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function AudioOutput({
  id,
  label,
  url,
}: {
  id: string;
  label: string;
  url: string;
}) {
  const { theme } = useUnistyles();
  const subscribe = useCallback(
    (listener: () => void) => mediaAudioPlayer.subscribe(id, listener),
    [id],
  );
  const getSnapshot = useCallback(() => mediaAudioPlayer.getSnapshot(id), [id]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const active = state === "playing" || state === "loading";
  const action = active ? "Stop" : state === "error" ? "Retry" : "Play";

  useEffect(() => () => mediaAudioPlayer.stop(id), [id]);

  return (
    <View style={styles.audioOutput} accessibilityLabel={label}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${action} ${label}`}
        accessibilityState={{ busy: state === "loading" }}
        onPress={() => mediaAudioPlayer.toggle(id, url)}
        style={styles.audioButton}
      >
        {state === "loading" ? (
          <ActivityDiamond size={16} color={theme.colors.accent.default} />
        ) : active ? (
          <Pause
            accessible={false}
            size={16}
            color={theme.colors.accent.default}
          />
        ) : (
          <Play
            accessible={false}
            size={16}
            color={theme.colors.accent.default}
          />
        )}
      </Pressable>
      <View style={styles.audioCopy}>
        <Text variant="caption" color="secondary" size="2xs" weight="semibold">
          Audio output
        </Text>
        <Text
          variant="caption"
          color={state === "error" ? "danger" : "muted"}
          size="2xs"
        >
          {state === "loading"
            ? "Loading…"
            : state === "playing"
              ? "Playing"
              : state === "error"
                ? "Could not play audio"
                : label.split(" · ").at(-1)}
        </Text>
      </View>
    </View>
  );
}

function DynamicDetail({
  detail,
  itemId,
}: {
  detail: Extract<NonNullable<ToolCall["detail"]>, { kind: "dynamic" }>;
  itemId: string;
}) {
  return (
    <View style={styles.commandDetail}>
      <View style={styles.commandMeta}>
        <Text variant="caption" color="muted" size="2xs">
          {detail.namespace ? `${detail.namespace} · ` : ""}
          {detail.tool}
        </Text>
        {detail.duration_ms != null ? (
          <Text variant="meta" size="2xs">
            {Math.max(1, Math.round(detail.duration_ms))} ms
          </Text>
        ) : null}
      </View>
      {detail.content_items.map((content, index) =>
        content.kind === "text" ? (
          <CodeBlock
            key={`text-${index}`}
            code={content.text}
            previewLines={12}
          />
        ) : (
          <ProviderToolImage
            key={`image-${index}`}
            url={content.url}
            label={`${detail.tool} output ${index + 1}`}
          />
        ),
      )}
      <JsonDisclosure
        label="Arguments"
        value={detail.arguments}
        resetKey={itemId}
      />
    </View>
  );
}

function ProviderToolImage({
  url,
  label,
  fallbackValue = { url },
}: {
  url: string;
  label: string;
  fallbackValue?: unknown;
}) {
  const [failed, setFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const closePreview = useCallback(() => setPreviewOpen(false), []);

  useEffect(() => {
    setFailed(false);
    setPreviewOpen(false);
  }, [url]);

  if (!isSafeMediaUrl(url, "image")) {
    return (
      <JsonDetail label={`${label} · unavailable`} value={fallbackValue} />
    );
  }
  if (failed) {
    return (
      <View
        style={styles.resourceDetail}
        accessible
        accessibilityRole="text"
        accessibilityLabel={`${label}, unavailable`}
      >
        <Text variant="caption" color="muted" size="2xs">
          Image unavailable
        </Text>
      </View>
    );
  }
  return (
    <>
      <Pressable
        onPress={() => setPreviewOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Preview ${label}`}
        accessibilityHint="Opens the image full screen"
        style={styles.outputImageTrigger}
      >
        <Image
          source={{ uri: url }}
          recyclingKey={url}
          cachePolicy="memory-disk"
          contentFit="contain"
          style={styles.outputImage}
          accessible={false}
          onError={() => {
            setFailed(true);
            setPreviewOpen(false);
          }}
        />
      </Pressable>
      <ImagePreviewModal
        visible={previewOpen}
        url={url}
        label={label}
        onClose={closePreview}
      />
    </>
  );
}

function JsonDetail({ label, value }: { label: string; value: unknown }) {
  const inspection = useMemo(() => formatInspectableValue(value), [value]);
  return (
    <View style={styles.jsonDetail}>
      <Text variant="meta" size="2xs" weight="semibold">
        {label}
      </Text>
      <CodeBlock code={inspection.text} language="json" previewLines={12} />
      {inspection.truncated ? (
        <Text variant="meta" size="2xs">
          Display limited for performance and safety.
        </Text>
      ) : null}
    </View>
  );
}

function JsonDisclosure({
  label,
  value,
  resetKey,
}: {
  label: string;
  value: unknown;
  resetKey: string;
}) {
  const { theme } = useUnistyles();
  const summary = useMemo(() => inspectableValueSummary(value), [value]);
  const { chevronStyle, isOpen, toggle } = useCollapsible(
    false,
    `${resetKey}:${label}`,
  );

  return (
    <View style={styles.jsonDisclosure}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${isOpen ? "Hide" : "Show"} ${label.toLowerCase()}, ${summary}`}
        accessibilityHint={`${isOpen ? "Collapses" : "Expands"} technical provider input`}
        accessibilityState={{ expanded: isOpen }}
        onPress={toggle}
        style={styles.jsonDisclosureHeader}
      >
        <Animated.View style={chevronStyle}>
          <ChevronRight
            accessible={false}
            size={theme.iconSize.xs}
            color={theme.colors.fg.faint}
          />
        </Animated.View>
        <Text variant="caption" color="muted" size="2xs" weight="semibold">
          {label}
        </Text>
        <Text
          variant="caption"
          color="muted"
          size="2xs"
          style={styles.jsonDisclosureSummary}
        >
          {summary}
        </Text>
      </Pressable>
      {isOpen ? <JsonDetail label={`${label} detail`} value={value} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface[2],
    borderRadius: theme.radius.lg,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    overflow: "hidden",
  },
  containerNested: {
    marginHorizontal: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: theme.minTouchTarget,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  title: {
    flex: 1,
  },
  body: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    paddingTop: theme.spacing[2],
    gap: theme.spacing[2],
  },
  commandDetail: {
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    borderRadius: theme.radius.md,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[1],
    padding: theme.spacing[2],
  },
  commandMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  commandCwd: {
    flex: 1,
  },
  commandActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  commandAction: {
    maxWidth: "100%",
    borderRadius: theme.radius.sm,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[3],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  artifactBadge: {
    borderRadius: theme.radius.full,
    borderCurve: "continuous",
    backgroundColor: theme.colors.accent.muted,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  testBadge: {
    borderRadius: theme.radius.full,
    borderCurve: "continuous",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  testBadgePassed: {
    backgroundColor: theme.colors.success.muted,
  },
  testBadgeFailed: {
    backgroundColor: theme.colors.danger.muted,
  },
  artifactSectionHeader: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  jsonDetail: {
    gap: theme.spacing[1],
    borderRadius: theme.radius.sm,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[2],
    padding: theme.spacing[2],
  },
  jsonDisclosure: {
    gap: theme.spacing[1],
    borderRadius: theme.radius.sm,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[2],
    overflow: "hidden",
  },
  jsonDisclosureHeader: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  jsonDisclosureSummary: {
    flex: 1,
    textAlign: "right",
  },
  resourceLinkContainer: {
    gap: theme.spacing[1],
  },
  resourceDetail: {
    minHeight: theme.minTouchTarget,
    gap: theme.spacing[1],
    borderRadius: theme.radius.sm,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[2],
    padding: theme.spacing[2],
  },
  resourceHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  resourceTitle: {
    flex: 1,
    gap: theme.spacing[1],
  },
  artifactTextPreview: {
    gap: theme.spacing[1],
  },
  audioOutput: {
    minHeight: theme.minTouchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.radius.sm,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[2],
    padding: theme.spacing[2],
  },
  audioButton: {
    width: theme.minTouchTarget,
    height: theme.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    borderCurve: "continuous",
    backgroundColor: theme.colors.accent.muted,
  },
  audioCopy: {
    flex: 1,
    gap: theme.spacing[1],
  },
  agentState: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    borderRadius: theme.radius.sm,
    borderCurve: "continuous",
    backgroundColor: theme.colors.surface[2],
    padding: theme.spacing[2],
  },
  agentStateMessage: {
    flex: 1,
  },
  reviewRationale: {
    flexDirection: "column",
  },
  hookUrgent: {
    borderWidth: 1,
    borderColor: theme.colors.warning.default,
  },
  outputImage: {
    width: "100%",
    height: 220,
    borderRadius: theme.radius.md,
  },
  outputImageTrigger: {
    width: "100%",
    borderRadius: theme.radius.md,
    borderCurve: "continuous",
    overflow: "hidden",
  },
}));
