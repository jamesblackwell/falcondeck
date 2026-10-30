import {
  normalizeThreadDetail,
  normalizeInteractiveRequest,
  type CloudJob,
  type CloudJobDetail,
  type CloudSettings,
  type CloudSourcePreview,
  type CreateCloudJobRequest,
  type InteractiveResponsePayload,
  type UpdateCloudSettingsRequest,
} from "@falcondeck/client-core";

export interface CloudApi {
  settings(): Promise<CloudSettings>;
  updateSettings(request: UpdateCloudSettingsRequest): Promise<CloudSettings>;
  capture(workspaceId: string): Promise<CloudSourcePreview>;
  jobs(workspaceId?: string): Promise<CloudJob[]>;
  create(request: CreateCloudJobRequest): Promise<CloudJob>;
  job(jobId: string): Promise<CloudJob>;
  detail(jobId: string): Promise<CloudJobDetail>;
  sendTurn(jobId: string, text: string): Promise<unknown>;
  interrupt(jobId: string): Promise<unknown>;
  respond(
    jobId: string,
    requestId: string,
    response: InteractiveResponsePayload,
  ): Promise<unknown>;
  collect(jobId: string): Promise<CloudJob>;
  importResult(jobId: string): Promise<CloudJob>;
  stop(jobId: string): Promise<CloudJob>;
  resume(jobId: string): Promise<CloudJob>;
}

export type CloudRpc = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

function normalizeCloudDetail(raw: unknown): CloudJobDetail {
  const metadata = raw as Partial<CloudJobDetail> | null;
  const requests = metadata?.interactive_requests;
  return {
    ...normalizeThreadDetail(raw),
    interactive_requests: Array.isArray(requests)
      ? requests
          .map(normalizeInteractiveRequest)
          .filter((request) => request !== null)
      : [],
    is_live: metadata?.is_live === true,
    collected_at:
      typeof metadata?.collected_at === "string" ? metadata.collected_at : null,
  };
}

function turnRequest(text: string) {
  return { workspace_id: "", thread_id: "", inputs: [{ type: "text", text }] };
}

function errorMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = payload.error;
    if (typeof error === "string") return error;
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return status === 404
    ? "Cloud tasks are unavailable on this host. Update its FalconDeck daemon."
    : `Cloud request failed (${status}).`;
}

export function createCloudHttpApi(baseUrl: string): CloudApi {
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${baseUrl}/api/cloud${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(payload, response.status));
    if (payload === null) throw new Error("The host returned no cloud result.");
    if (
      typeof payload === "object" &&
      "ok" in payload &&
      payload.ok === false
    ) {
      throw new Error(
        "message" in payload && typeof payload.message === "string"
          ? payload.message
          : "The cloud action was rejected.",
      );
    }
    return payload as T;
  }
  const jobPath = (jobId: string) => `/jobs/${encodeURIComponent(jobId)}`;
  return {
    settings: () => request("/settings"),
    updateSettings: (body) => request("/settings", "PUT", body),
    capture: (workspaceId) =>
      request("/capture", "POST", { workspace_id: workspaceId }),
    jobs: (workspaceId) =>
      request(
        `/jobs${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ""}`,
      ),
    create: (body) => request("/jobs", "POST", body),
    job: (jobId) => request(jobPath(jobId)),
    detail: async (jobId) =>
      normalizeCloudDetail(await request(`${jobPath(jobId)}/detail`)),
    sendTurn: (jobId, text) =>
      request(`${jobPath(jobId)}/turns`, "POST", turnRequest(text)),
    interrupt: (jobId) => request(`${jobPath(jobId)}/interrupt`, "POST", {}),
    respond: (jobId, requestId, response) =>
      request(
        `${jobPath(jobId)}/interactive/${encodeURIComponent(requestId)}`,
        "POST",
        { response },
      ),
    collect: (jobId) => request(`${jobPath(jobId)}/collect`, "POST", {}),
    importResult: (jobId) => request(`${jobPath(jobId)}/import`, "POST", {}),
    stop: (jobId) => request(`${jobPath(jobId)}/stop`, "POST", {}),
    resume: (jobId) => request(`${jobPath(jobId)}/resume`, "POST", {}),
  };
}

/** Uses the selected host's encrypted RPC transport, with no local fallback. */
export function createCloudRpcApi(transport: CloudRpc): CloudApi {
  const rpc: CloudRpc = async (method, params) => {
    const payload = await transport(method, params);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "ok" in payload &&
      payload.ok === false
    ) {
      throw new Error(
        "message" in payload && typeof payload.message === "string"
          ? payload.message
          : "The cloud action was rejected.",
      );
    }
    return payload;
  };
  const job = (jobId: string) => ({ job_id: jobId });
  return {
    settings: async () =>
      (await rpc("cloud.settings.get", {})) as CloudSettings,
    updateSettings: async (body) =>
      (await rpc("cloud.settings.update", { ...body })) as CloudSettings,
    capture: async (workspaceId) =>
      (await rpc("cloud.capture", {
        workspace_id: workspaceId,
      })) as CloudSourcePreview,
    jobs: async (workspaceId) =>
      (await rpc(
        "cloud.jobs.list",
        workspaceId ? { workspace_id: workspaceId } : {},
      )) as CloudJob[],
    create: async (body) =>
      (await rpc("cloud.jobs.create", { ...body })) as CloudJob,
    job: async (jobId) => (await rpc("cloud.jobs.get", job(jobId))) as CloudJob,
    detail: async (jobId) =>
      normalizeCloudDetail(await rpc("cloud.jobs.detail", job(jobId))),
    sendTurn: (jobId, text) =>
      rpc("cloud.jobs.turn", { ...job(jobId), request: turnRequest(text) }),
    interrupt: (jobId) => rpc("cloud.jobs.interrupt", job(jobId)),
    respond: (jobId, requestId, response) =>
      rpc("cloud.jobs.interactive", {
        ...job(jobId),
        request_id: requestId,
        request: { response },
      }),
    collect: async (jobId) =>
      (await rpc("cloud.jobs.collect", job(jobId))) as CloudJob,
    importResult: async (jobId) =>
      (await rpc("cloud.jobs.import", job(jobId))) as CloudJob,
    stop: async (jobId) =>
      (await rpc("cloud.jobs.stop", job(jobId))) as CloudJob,
    resume: async (jobId) =>
      (await rpc("cloud.jobs.resume", job(jobId))) as CloudJob,
  };
}

const connectionApis = new WeakMap<{ cloudRpc: CloudRpc }, CloudApi>();
export function cloudApiForConnection(connection: {
  cloudRpc: CloudRpc;
}): CloudApi {
  let api = connectionApis.get(connection);
  if (!api) {
    api = createCloudRpcApi((method, params) =>
      connection.cloudRpc(method, params),
    );
    connectionApis.set(connection, api);
  }
  return api;
}
