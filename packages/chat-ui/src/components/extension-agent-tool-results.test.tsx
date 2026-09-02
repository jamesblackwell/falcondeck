import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  ConversationItem,
  ExtensionSummary,
} from "@falcondeck/client-core";
import type { ExtensionAppRegistration } from "@falcondeck/extension-sdk/app";

import {
  ExtensionAgentToolDetailPanel,
  ExtensionAgentToolResultCards,
  ExtensionAgentToolUiProvider,
} from "./extension-agent-tool-results";

const extension: ExtensionSummary = {
  id: "example.missions",
  name: "Example Missions",
  version: "1.0.0",
  source: "bundled",
  bundled: true,
  enabled: true,
  status: "active",
  contributes: {
    threadMenuActions: [],
    panelActions: [{ id: "start-draft", title: "Start draft" }],
    threadDecorations: [],
    sidebarFilters: [],
    agentTools: [
      {
        id: "draft-mission",
        title: "Draft mission",
        description: "Draft a mission",
      },
    ],
  },
  permissions: [],
  granted_permissions: [],
};

const app: ExtensionAppRegistration = {
  extensionId: extension.id,
  panels: [],
  agentToolResults: [
    {
      toolId: "draft-mission",
      detail: { title: "Mission draft" },
      component: ({ result, invokeAction, presentation, openDetails }) => (
        <section>
          <h2>Review this Mission</h2>
          <span>{presentation}</span>
          <span>{JSON.stringify(result)}</span>
          {openDetails ? (
            <button type="button" onClick={openDetails}>
              Open details
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void invokeAction("start-draft", { draftId: "d1" })}
          >
            Start mission
          </button>
        </section>
      ),
    },
  ],
};

const item: Extract<ConversationItem, { kind: "tool_call" }> = {
  kind: "tool_call",
  id: "tool-1",
  title: "Draft mission",
  tool_kind: "mcp",
  status: "completed",
  output: null,
  exit_code: null,
  display: {
    is_read_only: false,
    has_side_effect: true,
    is_error: false,
    artifact_kind: "none",
    activity_kind: "other",
    history_mode: "summary",
    summary_hint: null,
  },
  detail: {
    kind: "mcp",
    server: "falcondeck-extensions",
    tool: "example_missions__draft_mission",
    arguments: { objective: "Ship it" },
    result: {
      structuredContent: {
        ok: true,
        result: { draftId: "d1" },
      },
      _meta: {
        "falcondeck/extensionTool": {
          extensionId: extension.id,
          toolId: "draft-mission",
        },
      },
    },
    error: null,
    duration_ms: 10,
    app_context: null,
  },
  created_at: "2026-09-01T08:00:00.000Z",
  completed_at: "2026-09-01T08:00:01.000Z",
};

describe("ExtensionAgentToolResultCards", () => {
  it("renders a declared extension-owned result and routes its human action", async () => {
    const invokeAction = vi.fn(async () => ({ result: {}, updated_views: [] }));
    const openDetails = vi.fn();
    render(
      <ExtensionAgentToolUiProvider
        apps={new Map([[extension.id, app]])}
        extensions={[extension]}
        views={[]}
        onInvokeAction={invokeAction}
        onOpenDetails={openDetails}
      >
        <ExtensionAgentToolResultCards items={[item]} />
      </ExtensionAgentToolUiProvider>,
    );

    expect(screen.getByText("Review this Mission")).toBeVisible();
    expect(screen.getByText("inline")).toBeVisible();
    expect(screen.getByText(/\"draftId\":\"d1\"/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    expect(openDetails).toHaveBeenCalledWith({
      extensionId: extension.id,
      toolId: "draft-mission",
      arguments: { objective: "Ship it" },
      result: { ok: true, result: { draftId: "d1" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start mission" }));
    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith(
        extension.id,
        "start-draft",
        { draftId: "d1" },
        undefined,
      ),
    );
  });

  it("renders the selected result in the host-owned detail surface", () => {
    const onClose = vi.fn();
    render(
      <ExtensionAgentToolUiProvider
        apps={new Map([[extension.id, app]])}
        extensions={[extension]}
        views={[]}
        onInvokeAction={vi.fn()}
      >
        <ExtensionAgentToolDetailPanel
          selection={{
            extensionId: extension.id,
            toolId: "draft-mission",
            arguments: { objective: "Ship it" },
            result: { ok: true, result: { draftId: "d1" } },
          }}
          onClose={onClose}
        />
      </ExtensionAgentToolUiProvider>,
    );

    expect(screen.getByText("Mission draft")).toBeVisible();
    expect(screen.getByText("detail")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not mount an undeclared or disabled trusted renderer", () => {
    render(
      <ExtensionAgentToolUiProvider
        apps={new Map([[extension.id, app]])}
        extensions={[{ ...extension, enabled: false, status: "disabled" }]}
        views={[]}
        onInvokeAction={vi.fn()}
      >
        <ExtensionAgentToolResultCards items={[item]} />
      </ExtensionAgentToolUiProvider>,
    );

    expect(screen.queryByText("Review this Mission")).not.toBeInTheDocument();
  });
});
