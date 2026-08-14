import { memo } from "react";

import type {
  ConversationItem,
  ConversationRenderBlock,
} from "@falcondeck/client-core";

import { UserMessageBlock } from "./UserMessageBlock";
import { AssistantMessageBlock } from "./AssistantMessageBlock";
import { ServiceBlock } from "./ServiceBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { ToolBurstBlock } from "./ToolBurstBlock";
import { WorkSessionBlock } from "./WorkSessionBlock";
import { PlanBlock } from "./PlanBlock";
import { ConnectedReasoningBlock } from "./ReasoningBlock";
import { DiffBlock } from "./DiffBlock";
import { FileChangeBlock } from "./FileChangeBlock";
import { InteractiveRequestBlock } from "./InteractiveRequestBlock";
import { UnsupportedBlock } from "./UnsupportedBlock";
import { ImageOutputBlock } from "./ImageOutputBlock";
import { WebSearchBlock } from "./WebSearchBlock";
import { RealtimeEventBlock } from "./RealtimeEventBlock";
import { ContextCompactionBlock } from "./ContextCompactionBlock";
import { CodeReviewBlock } from "./CodeReviewBlock";
import { ArtifactBlock } from "./ArtifactBlock";

interface MessageRouterProps {
  item: ConversationRenderBlock;
  /**
   * Accepted for call-site compatibility but unused: live interactive
   * requests are handled exclusively by the pinned InteractiveRequestBanner
   * (which knows the full flow — question forms, AlwaysAllow, offered
   * decisions); the transcript only renders resolved receipts.
   */
  onApprovalDecision?: (requestId: string, decision: "allow" | "deny") => void;
  canRetryResponse?: boolean;
  retrySource?: Extract<ConversationItem, { kind: "user_message" }> | null;
  onRetryResponse?: (
    item: Extract<ConversationItem, { kind: "user_message" }>,
  ) => void;
}

export const MessageRouter = memo(function MessageRouter({
  item: block,
  canRetryResponse = false,
  retrySource = null,
  onRetryResponse,
}: MessageRouterProps) {
  if (block.kind === "tool_summary") {
    return (
      <ToolBurstBlock
        key={block.id}
        items={block.items}
        summary={block.summary}
        defaultOpen={block.default_open}
        suppressDetail={block.suppress_read_only_detail}
      />
    );
  }

  if (block.kind === "work_session") {
    return (
      <WorkSessionBlock
        key={block.id}
        items={block.items}
        running={block.running}
        startedAt={block.started_at}
        completedAt={block.completed_at}
      />
    );
  }

  const { item } = block;

  switch (item.kind) {
    case "user_message":
      return <UserMessageBlock key={block.id} item={item} />;
    case "assistant_message":
      return (
        <AssistantMessageBlock
          key={block.id}
          item={item}
          retrySource={canRetryResponse ? retrySource : null}
          onRetryResponse={canRetryResponse ? onRetryResponse : undefined}
        />
      );
    case "image":
      return <ImageOutputBlock key={block.id} item={item} />;
    case "web_search":
      return <WebSearchBlock key={block.id} item={item} />;
    case "file_change":
      return (
        <FileChangeBlock
          key={block.id}
          item={item}
          defaultOpen={block.default_open}
        />
      );
    case "service":
      return <ServiceBlock key={block.id} item={item} />;
    case "realtime":
      return <RealtimeEventBlock key={block.id} item={item} />;
    case "tool_call":
      return (
        <ToolCallBlock
          key={block.id}
          item={item}
          defaultOpen={block.default_open}
          suppressDetail={block.suppress_read_only_detail}
        />
      );
    case "reasoning":
      return <ConnectedReasoningBlock key={block.id} item={item} />;
    case "context_compaction":
      return <ContextCompactionBlock key={block.id} item={item} />;
    case "artifact":
      return <ArtifactBlock key={block.id} item={item} />;
    case "code_review":
      return <CodeReviewBlock key={block.id} item={item} />;
    case "plan":
      return <PlanBlock key={block.id} item={item} />;
    case "diff":
      return (
        <DiffBlock
          key={block.id}
          item={item}
          defaultOpen={block.default_open}
        />
      );
    case "interactive_request":
      return <InteractiveRequestBlock key={block.id} item={item} />;
    case "unsupported":
      return <UnsupportedBlock key={block.id} item={item} />;
    default:
      return <UnsupportedBlock key={block.id} item={item as unknown} />;
  }
});
