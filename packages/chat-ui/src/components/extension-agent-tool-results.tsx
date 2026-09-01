import {
  Component,
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ErrorInfo,
  type ReactNode,
} from "react";

import {
  extensionToolResultIdentity,
  parseMcpResult,
  type ConversationItem,
  type ExtensionActionResponse,
  type ExtensionSummary,
  type ExtensionView,
} from "@falcondeck/client-core";
import type {
  ExtensionAppActionResponse,
  ExtensionAppAgentToolResultRegistration,
  ExtensionAppRegistration,
  ExtensionAppView,
  ExtensionAppViewScope,
} from "@falcondeck/extension-sdk/app";

type RegisteredResult = {
  extension: ExtensionSummary;
  registration: ExtensionAppAgentToolResultRegistration;
};

type ToolUiContextValue = {
  registrations: ReadonlyMap<string, RegisteredResult>;
  views: readonly ExtensionView[];
  invokeAction(
    extensionId: string,
    actionId: string,
    input?: unknown,
    target?: ExtensionAppViewScope | null,
  ): Promise<ExtensionActionResponse>;
};

const ToolUiContext = createContext<ToolUiContextValue | null>(null);

function registrationKey(extensionId: string, toolId: string) {
  return `${extensionId}\u0000${toolId}`;
}

function appViewsFor(
  views: readonly ExtensionView[],
  extensionId: string,
): ExtensionAppView[] {
  return views
    .filter((view) => view.extension_id === extensionId)
    .map((view) => ({
      viewId: view.view_id,
      scope: view.scope,
      value: view.value,
      updatedAt: view.updated_at,
    }));
}

export function ExtensionAgentToolUiProvider({
  apps,
  extensions,
  views,
  onInvokeAction,
  children,
}: {
  apps: ReadonlyMap<string, ExtensionAppRegistration>;
  extensions: readonly ExtensionSummary[];
  views: readonly ExtensionView[];
  onInvokeAction: ToolUiContextValue["invokeAction"];
  children: ReactNode;
}) {
  const registrations = useMemo(() => {
    const next = new Map<string, RegisteredResult>();
    for (const extension of extensions) {
      if (!extension.enabled || extension.status !== "active") continue;
      const app = apps.get(extension.id);
      if (!app) continue;
      const declaredTools = new Set(
        (extension.contributes.agentTools ?? []).map((tool) => tool.id),
      );
      for (const registration of app.agentToolResults) {
        if (!declaredTools.has(registration.toolId)) continue;
        next.set(registrationKey(extension.id, registration.toolId), {
          extension,
          registration,
        });
      }
    }
    return next;
  }, [apps, extensions]);
  const value = useMemo(
    () => ({ registrations, views, invokeAction: onInvokeAction }),
    [onInvokeAction, registrations, views],
  );
  return <ToolUiContext.Provider value={value}>{children}</ToolUiContext.Provider>;
}

class ToolResultBoundary extends Component<
  { extensionName: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `Extension frontend ${this.props.extensionName} crashed while rendering an agent tool result`,
      error,
      info,
    );
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          className="rounded-[var(--fd-radius-lg)] border border-danger/30 bg-danger-muted px-4 py-3 text-[length:var(--fd-text-sm)] text-danger"
        >
          {this.props.extensionName} could not render this result. The ordinary
          tool result is still available in the transcript.
        </div>
      );
    }
    return this.props.children;
  }
}

type MatchedToolResult = {
  item: Extract<ConversationItem, { kind: "tool_call" }>;
  identity: { extensionId: string; toolId: string };
  registered: RegisteredResult;
};

/**
 * Renders the newest actionable result for each extension tool at transcript
 * level, so it remains visible even when the provider's work session is folded.
 */
export function ExtensionAgentToolResultCards({
  items,
}: {
  items: readonly ConversationItem[];
}) {
  const context = useContext(ToolUiContext);
  const matches = useMemo(() => {
    if (!context) return [];
    const seen = new Set<string>();
    const found: MatchedToolResult[] = [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (
        item.kind !== "tool_call" ||
        item.detail?.kind !== "mcp" ||
        item.detail.server !== "falcondeck-extensions" ||
        item.detail.result == null
      ) {
        continue;
      }
      const identity = extensionToolResultIdentity(item.detail.result);
      if (!identity) continue;
      const key = registrationKey(identity.extensionId, identity.toolId);
      if (seen.has(key)) continue;
      const registered = context.registrations.get(key);
      if (!registered) continue;
      seen.add(key);
      found.push({ item, identity, registered });
    }
    return found.reverse();
  }, [context, items]);

  if (!context || matches.length === 0) return null;
  return (
    <div className="space-y-3" data-extension-agent-tool-results>
      {matches.map(({ item, identity, registered }) => (
        <ToolResultCard
          key={`${identity.extensionId}:${identity.toolId}:${item.id}`}
          item={item}
          identity={identity}
          registered={registered}
          context={context}
        />
      ))}
    </div>
  );
}

function ToolResultCard({
  item,
  identity,
  registered,
  context,
}: MatchedToolResult & { context: ToolUiContextValue }) {
  const Component = registered.registration.component;
  const views = useMemo(
    () => appViewsFor(context.views, identity.extensionId),
    [context.views, identity.extensionId],
  );
  const invokeAction = useCallback(
    async (
      actionId: string,
      input?: unknown,
      target?: ExtensionAppViewScope | null,
    ): Promise<ExtensionAppActionResponse> => {
      const response = await context.invokeAction(
        identity.extensionId,
        actionId,
        input,
        target,
      );
      return {
        result: response.result,
        updatedViews: appViewsFor(response.updated_views, identity.extensionId),
      };
    },
    [context, identity.extensionId],
  );
  const detail = item.detail?.kind === "mcp" ? item.detail : null;
  const result = detail ? parseMcpResult(detail.result).structured_content : null;

  return (
    <ToolResultBoundary extensionName={registered.extension.name}>
      <Component
        extensionId={identity.extensionId}
        toolId={identity.toolId}
        arguments={detail?.arguments}
        result={result}
        views={views}
        invokeAction={invokeAction}
      />
    </ToolResultBoundary>
  );
}
