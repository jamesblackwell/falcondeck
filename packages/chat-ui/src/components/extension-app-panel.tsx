import {
  Component,
  useCallback,
  useMemo,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from "react";

import type {
  ExtensionActionResponse,
  ExtensionPanelDefinition,
  ExtensionSummary,
  ExtensionView,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import type {
  ExtensionAppActionResponse,
  ExtensionAppPanelRegistration,
  ExtensionAppViewScope,
} from "@falcondeck/extension-sdk/app";

import { ExtensionPanel } from "./extension-panel";

class ExtensionAppBoundary extends Component<
  { extensionName: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `Extension frontend ${this.props.extensionName} crashed`,
      error,
      info,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <div
            role="alert"
            className="max-w-md rounded-[var(--fd-radius-lg)] border border-danger/30 bg-danger-muted p-5 text-center text-[length:var(--fd-text-sm)] text-danger"
          >
            {this.props.extensionName} could not render this panel.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ExtensionAppPanel({
  panel,
  registration,
  extension,
  threads,
  workspaces = [],
  views,
  onInvokeAction,
  onOpenThread,
  onStartTask,
  onOpenExtensionSettings,
  onClose,
}: {
  panel: ExtensionPanelDefinition;
  registration: ExtensionAppPanelRegistration;
  extension: ExtensionSummary;
  threads: readonly ThreadSummary[];
  workspaces?: readonly WorkspaceSummary[];
  views: readonly ExtensionView[];
  onInvokeAction(
    panel: ExtensionPanelDefinition,
    actionId: string,
    input?: unknown,
    target?: ExtensionAppViewScope | null,
  ): Promise<ExtensionActionResponse>;
  onOpenThread(workspaceId: string, threadId: string): void;
  onStartTask?(draft: string): void;
  onOpenExtensionSettings?(): void;
  onClose(): void;
}) {
  const grantedPermissions = extension.granted_permissions ?? [];
  const hasThreadRead = grantedPermissions.includes("threads:read");
  const appThreads = useMemo(
    () =>
      hasThreadRead
        ? threads.map((thread) => ({
            id: thread.id,
            workspaceId: thread.workspace_id,
            title: thread.title,
            status: thread.status,
            updatedAt: thread.updated_at,
            pendingApprovalCount: thread.attention.pending_approval_count,
            pendingQuestionCount: thread.attention.pending_question_count,
          }))
        : [],
    [hasThreadRead, threads],
  );
  // Share the folder basename only; the full path stays with the host.
  const appWorkspaces = useMemo(
    () =>
      hasThreadRead
        ? workspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.path.split("/").pop() || workspace.path,
            kind: workspace.kind,
          }))
        : [],
    [hasThreadRead, workspaces],
  );
  const appViews = useMemo(
    () =>
      views
        .filter((view) => view.extension_id === extension.id)
        .map((view) => ({
          viewId: view.view_id,
          scope: view.scope,
          value: view.value,
          updatedAt: view.updated_at,
        })),
    [extension.id, views],
  );
  const hasPermission = useCallback(
    (permission: string) => grantedPermissions.includes(permission),
    [grantedPermissions],
  );
  const invocationRef = useRef({ panel, onInvokeAction });
  invocationRef.current = { panel, onInvokeAction };
  const invokeAction = useCallback(
    async (
      actionId: string,
      input?: unknown,
      target?: ExtensionAppViewScope | null,
    ): Promise<ExtensionAppActionResponse> => {
      const current = invocationRef.current;
      const response = await current.onInvokeAction(
        current.panel,
        actionId,
        input,
        target,
      );
      return {
        result: response.result,
        updatedViews: response.updated_views.map((view) => ({
          viewId: view.view_id,
          scope: view.scope,
          value: view.value,
          updatedAt: view.updated_at,
        })),
      };
    },
    [],
  );
  const Component = registration.component;

  return (
    <ExtensionPanel panel={panel} onClose={onClose}>
      <ExtensionAppBoundary extensionName={extension.name}>
        <Component
          extensionId={extension.id}
          threads={appThreads}
          workspaces={appWorkspaces}
          views={appViews}
          hasPermission={hasPermission}
          invokeAction={invokeAction}
          openThread={onOpenThread}
          startTask={onStartTask}
          openExtensionSettings={onOpenExtensionSettings}
        />
      </ExtensionAppBoundary>
    </ExtensionPanel>
  );
}
