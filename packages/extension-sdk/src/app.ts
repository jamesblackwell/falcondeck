import type { ComponentType } from "react";

export type ExtensionAppViewScope = {
  kind: string;
  id: string;
};

export type ExtensionAppView = {
  viewId: string;
  scope?: ExtensionAppViewScope | null;
  value: unknown;
  updatedAt: string;
};

export type ExtensionAppWorkspaceSummary = {
  id: string;
  /** Display name (folder basename); full filesystem paths are never shared. */
  name: string;
  kind?: "project" | "casual";
};

export type ExtensionAppThreadSummary = {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  updatedAt: string;
  pendingApprovalCount: number;
  pendingQuestionCount: number;
};

export type ExtensionAppActionResponse = {
  result: unknown;
  updatedViews: ExtensionAppView[];
};

export type ExtensionAppPanelProps = {
  extensionId: string;
  threads: readonly ExtensionAppThreadSummary[];
  /** Absent when the host predates workspace summaries. */
  workspaces?: readonly ExtensionAppWorkspaceSummary[];
  views: readonly ExtensionAppView[];
  hasPermission(permission: string): boolean;
  invokeAction(
    actionId: string,
    input?: unknown,
    target?: ExtensionAppViewScope | null,
  ): Promise<ExtensionAppActionResponse>;
  openThread(workspaceId: string, threadId: string): void;
  /** Opens a new task in the host's current workspace with an editable draft. */
  startTask?(draft: string): void;
  /** Opens the host's extension settings when that surface is available. */
  openExtensionSettings?(): void;
};

export type ExtensionAppPanelRegistration = {
  id: string;
  title: string;
  icon?: string;
  component: ComponentType<ExtensionAppPanelProps>;
};

/** Props for a trusted rendering of one manifest-declared agent-tool result. */
export type ExtensionAppAgentToolResultProps = {
  extensionId: string;
  toolId: string;
  arguments: unknown;
  result: unknown;
  views: readonly ExtensionAppView[];
  invokeAction(
    actionId: string,
    input?: unknown,
    target?: ExtensionAppViewScope | null,
  ): Promise<ExtensionAppActionResponse>;
};

export type ExtensionAppAgentToolResultRegistration = {
  toolId: string;
  component: ComponentType<ExtensionAppAgentToolResultProps>;
};

export type ExtensionAppRegistration = {
  extensionId: string;
  panels: readonly ExtensionAppPanelRegistration[];
  agentToolResults: readonly ExtensionAppAgentToolResultRegistration[];
};

export type ExtensionAppDefinition = {
  readonly apiVersion: 1;
  readonly extensionId: string;
  readonly setup: (app: ExtensionAppBuilder) => void;
};

export type ExtensionAppBuilder = {
  panels: {
    register(panel: ExtensionAppPanelRegistration): void;
  };
  agentToolResults: {
    register(result: ExtensionAppAgentToolResultRegistration): void;
  };
};

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

export function defineExtensionApp(
  extensionId: string,
  setup: (app: ExtensionAppBuilder) => void,
): ExtensionAppDefinition {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new Error(`Invalid extension app id: ${extensionId}`);
  }
  return Object.freeze({ apiVersion: 1 as const, extensionId, setup });
}

export function collectExtensionApp(
  definition: ExtensionAppDefinition,
): ExtensionAppRegistration {
  if (
    definition.apiVersion !== 1 ||
    !EXTENSION_ID_PATTERN.test(definition.extensionId)
  ) {
    throw new Error("Unsupported extension app definition");
  }
  const panels: ExtensionAppPanelRegistration[] = [];
  const panelIds = new Set<string>();
  const agentToolResults: ExtensionAppAgentToolResultRegistration[] = [];
  const agentToolIds = new Set<string>();
  definition.setup({
    panels: {
      register(panel) {
        if (!ID_PATTERN.test(panel.id) || panelIds.has(panel.id)) {
          throw new Error(
            `Invalid or duplicate extension panel id: ${panel.id}`,
          );
        }
        if (!panel.title.trim() || typeof panel.component !== "function") {
          throw new Error(`Invalid extension panel registration: ${panel.id}`);
        }
        panelIds.add(panel.id);
        panels.push(Object.freeze({ ...panel }));
      },
    },
    agentToolResults: {
      register(result) {
        if (!ID_PATTERN.test(result.toolId) || agentToolIds.has(result.toolId)) {
          throw new Error(
            `Invalid or duplicate extension agent-tool result id: ${result.toolId}`,
          );
        }
        if (typeof result.component !== "function") {
          throw new Error(
            `Invalid extension agent-tool result registration: ${result.toolId}`,
          );
        }
        agentToolIds.add(result.toolId);
        agentToolResults.push(Object.freeze({ ...result }));
      },
    },
  });
  return Object.freeze({
    extensionId: definition.extensionId,
    panels: Object.freeze(panels),
    agentToolResults: Object.freeze(agentToolResults),
  });
}
