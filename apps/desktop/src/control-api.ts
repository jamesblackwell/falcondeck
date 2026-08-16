import type {
  AgentControlSettings,
  Automation,
  AutomationRun,
  ControlAuditEntry,
  ControlErrorDetail,
  ControlExecuteRequest,
  ControlGetResponse,
  ControlSearchResponse,
} from "@falcondeck/client-core";

/**
 * Typed helpers for the daemon's generic control routes. The desktop panels
 * and the MCP server call the same three endpoints — the control service is
 * the single source of behaviour.
 */

export class ControlRequestError extends Error {
  readonly detail: ControlErrorDetail | null;

  constructor(detail: ControlErrorDetail | null, message: string) {
    super(message);
    this.name = "ControlRequestError";
    this.detail = detail;
  }
}

async function controlPost<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = (payload as { error?: ControlErrorDetail } | null)?.error ?? null;
    throw new ControlRequestError(
      detail,
      detail?.message ?? `daemon returned ${response.status}`,
    );
  }
  return payload as T;
}

export function searchCapabilities(
  baseUrl: string,
  query: { query?: string; domain?: string; operation?: string; detail?: "summary" | "full" },
): Promise<ControlSearchResponse> {
  return controlPost(baseUrl, "/api/control/search", query);
}

export async function readSettings(baseUrl: string): Promise<AgentControlSettings> {
  const response = await controlPost<ControlGetResponse>(
    baseUrl,
    "/api/control/get",
    { resource: "agent_control.settings" },
  );
  return response.data as AgentControlSettings;
}

export async function updateSettings(
  baseUrl: string,
  arguments_: Partial<{
    enabled: boolean;
    providers: Record<string, { enabled: boolean }>;
    default_timezone: string;
    allow_elevated_automations: boolean;
    confirmation_policy: { destructive_operations: boolean; sensitive_operations: boolean };
  }>,
): Promise<AgentControlSettings> {
  const response = await controlPost<{
    ok: boolean;
    data?: AgentControlSettings;
    error?: ControlErrorDetail;
  }>(baseUrl, "/api/control/execute", {
    operation: "agent_control.settings.update",
    arguments: arguments_,
  });
  if (!response.ok || !response.data) {
    throw new ControlRequestError(
      response.error ?? null,
      response.error?.message ?? "FalconDeck returned no control result.",
    );
  }
  return response.data;
}

export async function listAutomations(baseUrl: string): Promise<Automation[]> {
  const response = await controlPost<ControlGetResponse>(
    baseUrl,
    "/api/control/get",
    { resource: "automations", limit: 100 },
  );
  const rows = Array.isArray(response.data) ? (response.data as Automation[]) : [];
  return rows;
}

export async function readAutomation(
  baseUrl: string,
  id: string,
): Promise<Automation | null> {
  const response = await controlPost<ControlGetResponse>(
    baseUrl,
    "/api/control/get",
    { resource: "automation", id },
  );
  return (response.data as Automation | null) ?? null;
}

export async function listRuns(
  baseUrl: string,
  automationId: string,
): Promise<AutomationRun[]> {
  const response = await controlPost<ControlGetResponse>(
    baseUrl,
    "/api/control/get",
    { resource: "automation.runs", id: automationId, limit: 50 },
  );
  return Array.isArray(response.data) ? (response.data as AutomationRun[]) : [];
}

export async function listAudit(baseUrl: string): Promise<ControlAuditEntry[]> {
  const response = await controlPost<ControlGetResponse>(
    baseUrl,
    "/api/control/get",
    { resource: "control.audit", limit: 20 },
  );
  return Array.isArray(response.data) ? (response.data as ControlAuditEntry[]) : [];
}

/** Executes one control operation, returning data or throwing a structured
 * error carrying the daemon's ControlErrorDetail. */
export async function executeControl<T>(
  baseUrl: string,
  request: ControlExecuteRequest,
): Promise<T> {
  const response = await controlPost<{
    ok: boolean;
    data?: T;
    error?: ControlErrorDetail;
  }>(baseUrl, "/api/control/execute", request);
  if (!response.ok) {
    throw new ControlRequestError(
      response.error ?? null,
      response.error?.message ?? "FalconDeck returned no control result.",
    );
  }
  return response.data as T;
}
