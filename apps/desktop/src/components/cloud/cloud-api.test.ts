import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudJob, CreateCloudJobRequest, InteractiveResponsePayload } from "@falcondeck/client-core";
import { createCloudHttpApi, createCloudRpcApi } from "./cloud-api";

const baseUrl = "http://owning-daemon.test:4317";
const jobId = "job/a?b#c%";
const requestId = "approval/a?b#c%";
const response: InteractiveResponsePayload = { kind: "approval", decision: "allow" };
const createdAt = "2026-10-30T10:00:00Z";
const collectedAt = "2026-10-30T10:15:00Z";

function resumedJob(): CloudJob {
  return {
    id: jobId,
    workspace_id: "source-project",
    source: {
      id: "reviewed-source",
      workspace_id: "source-project",
      base_head: "base-commit",
      tree_hash: "reviewed-tree",
      included_paths: ["src/current.ts"],
      excluded_paths: [".env"],
      total_bytes: 1024,
      created_at: createdAt,
    },
    status: "running",
    prompt: "Continue the saved native task",
    model_id: null,
    worker: { workspace_id: "worker-project", thread_id: "native-task", provider: "codex" },
    result: null,
    error: null,
    created_at: createdAt,
    updated_at: collectedAt,
    expires_at: null,
  };
}

function nativeDetail(isLive: boolean, collectionTime: string | null) {
  return {
    workspace: { id: "worker-project", path: "/workspace/source", kind: "project" },
    thread: { id: "native-task", workspace_id: "worker-project", title: "Cloud native task", provider: "codex" },
    items: [{ kind: "assistant_message", id: "native-answer", text: "Native result", created_at: createdAt }],
    interactive_requests: [{
      request_id: requestId,
      workspace_id: "worker-project",
      thread_id: "native-task",
      method: "item/commandExecution/requestApproval",
      kind: "approval",
      title: "Run checks",
      command: "npm test",
      questions: [],
      created_at: createdAt,
    }],
    is_live: isLive,
    collected_at: collectionTime,
  };
}

function http(payload: unknown = { ok: true }, status = 200) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function rejectsWithMessage(operation: Promise<unknown>, message: string) {
  const error: unknown = await operation.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloud HTTP API", () => {
  it("resumes the encoded cloud job and returns the host's resumed job", async () => {
    const expected = resumedJob();
    const fetch = http(expected);
    await expect(createCloudHttpApi(baseUrl).resume(jobId)).resolves.toEqual(expected);
    expect(fetch).toHaveBeenCalledWith(`${baseUrl}/api/cloud/jobs/${encodeURIComponent(jobId)}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  });

  it.each([[true, null], [false, collectedAt]] as const)("preserves native detail metadata and pending requests over HTTP (live=%s)", async (isLive, collectionTime) => {
    const raw = nativeDetail(isLive, collectionTime);
    const fetch = http(raw);
    const detail = await createCloudHttpApi(baseUrl).detail(jobId);

    expect(detail.is_live).toBe(isLive);
    expect(detail.collected_at).toBe(collectionTime);
    expect(detail.interactive_requests).toMatchObject(raw.interactive_requests);
    expect(detail.items).toMatchObject(raw.items);
    expect(detail.thread.id).toBe("native-task");
    expect(fetch.mock.calls[0][0]).toBe(`${baseUrl}/api/cloud/jobs/${encodeURIComponent(jobId)}/detail`);
  });

  it("encodes job, workspace, and native request identifiers at the transport boundary", async () => {
    const fetch = http();
    const api = createCloudHttpApi(baseUrl);
    await api.job(jobId);
    await api.jobs("workspace/a?b#c%");
    await api.respond(jobId, requestId, response);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${baseUrl}/api/cloud/jobs/job%2Fa%3Fb%23c%25`,
      `${baseUrl}/api/cloud/jobs?workspace_id=workspace%2Fa%3Fb%23c%25`,
      `${baseUrl}/api/cloud/jobs/job%2Fa%3Fb%23c%25/interactive/approval%2Fa%3Fb%23c%25`,
    ]);
  });

  it("sends the native SendTurnRequest input shape for follow-up turns", async () => {
    const fetch = http();
    await createCloudHttpApi(baseUrl).sendTurn(jobId, "Continue the implementation");

    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/cloud/jobs/${encodeURIComponent(jobId)}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: "",
          thread_id: "",
          inputs: [{ type: "text", text: "Continue the implementation" }],
        }),
      },
    );
  });

  it("wraps interactive responses in the native InteractiveResponseRequest body", async () => {
    const fetch = http();
    await createCloudHttpApi(baseUrl).respond(jobId, requestId, response);
    expect(fetch.mock.calls[0][1]).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
    });
  });

  it("preserves source capture, admission identity, and explicit settings updates", async () => {
    const fetch = http();
    const api = createCloudHttpApi(baseUrl);
    const create: CreateCloudJobRequest = {
      workspace_id: "source-project",
      source_capture_id: "reviewed-current-source",
      prompt: "Fix the failing test",
      idempotency_key: "admission-identity",
      model_id: "selected-model",
    };
    await api.capture("source-project");
    await api.create(create);
    await api.updateSettings({ enabled: true, provider_token: "", timeout_minutes: 15 });

    expect(fetch.mock.calls.map(([, init]) => ({ method: init.method, body: JSON.parse(init.body) }))).toEqual([
      { method: "POST", body: { workspace_id: "source-project" } },
      { method: "POST", body: create },
      { method: "PUT", body: { enabled: true, provider_token: "", timeout_minutes: 15 } },
    ]);
  });

  it("does not treat a rejected worker command as success even when HTTP succeeds", async () => {
    http({ ok: false, message: "The native request expired" });
    await rejectsWithMessage(createCloudHttpApi(baseUrl).respond(jobId, requestId, response), "The native request expired");
  });

  it.each([
    [{ error: "Source capture expired" }, 409, "Source capture expired"],
    [{ error: { message: "Worker is unavailable" } }, 503, "Worker is unavailable"],
    [{}, 404, "Cloud tasks are unavailable on this host"],
    [{}, 502, "Cloud request failed (502)"],
  ])("reports a server failure without inventing a successful result", async (payload, status, message) => {
    http(payload, status as number);
    await rejectsWithMessage(createCloudHttpApi(baseUrl).job(jobId), message as string);
  });

  it("rejects an empty successful response instead of inventing a cloud result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    await rejectsWithMessage(createCloudHttpApi(baseUrl).stop(jobId), "The host returned no cloud result");
  });
});

describe("cloud owner RPC API", () => {
  it("resumes only through the owning host's RPC and returns its resumed job", async () => {
    const expected = resumedJob();
    const fetch = http();
    const rpc = vi.fn().mockResolvedValue(expected);
    await expect(createCloudRpcApi(rpc).resume(jobId)).resolves.toBe(expected);
    expect(rpc).toHaveBeenCalledWith("cloud.jobs.resume", { job_id: jobId });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[true, null], [false, collectedAt]] as const)("preserves native detail metadata and pending requests over owner RPC (live=%s)", async (isLive, collectionTime) => {
    const raw = nativeDetail(isLive, collectionTime);
    const fetch = http();
    const rpc = vi.fn().mockResolvedValue(raw);
    const detail = await createCloudRpcApi(rpc).detail(jobId);

    expect(detail.is_live).toBe(isLive);
    expect(detail.collected_at).toBe(collectionTime);
    expect(detail.interactive_requests).toMatchObject(raw.interactive_requests);
    expect(detail.items).toMatchObject(raw.items);
    expect(detail.thread.id).toBe("native-task");
    expect(rpc).toHaveBeenCalledWith("cloud.jobs.detail", { job_id: jobId });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes cloud operations exclusively through the supplied owner's RPC", async () => {
    const fetch = http();
    const rpc = vi.fn().mockResolvedValue({ ok: true });
    const api = createCloudRpcApi(rpc);
    await api.settings();
    await api.capture("remote-project");
    await api.jobs("remote-project");
    await api.job(jobId);
    await api.collect(jobId);
    await api.importResult(jobId);
    await api.stop(jobId);

    expect(rpc.mock.calls).toEqual([
      ["cloud.settings.get", {}],
      ["cloud.capture", { workspace_id: "remote-project" }],
      ["cloud.jobs.list", { workspace_id: "remote-project" }],
      ["cloud.jobs.get", { job_id: jobId }],
      ["cloud.jobs.collect", { job_id: jobId }],
      ["cloud.jobs.import", { job_id: jobId }],
      ["cloud.jobs.stop", { job_id: jobId }],
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the backend's native turn and interactive RPC wrappers", async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true });
    const api = createCloudRpcApi(rpc);
    await api.sendTurn(jobId, "Run the checks");
    await api.respond(jobId, requestId, response);
    await api.interrupt(jobId);

    expect(rpc.mock.calls).toEqual([
      ["cloud.jobs.turn", {
        job_id: jobId,
        request: { workspace_id: "", thread_id: "", inputs: [{ type: "text", text: "Run the checks" }] },
      }],
      ["cloud.jobs.interactive", { job_id: jobId, request_id: requestId, request: { response } }],
      ["cloud.jobs.interrupt", { job_id: jobId }],
    ]);
  });

  it("propagates an owning host's rejection without a local HTTP fallback", async () => {
    const fetch = http();
    const rpc = vi.fn().mockRejectedValue(new Error("Owning host disconnected"));
    await rejectsWithMessage(createCloudRpcApi(rpc).capture("remote-project"), "Owning host disconnected");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not treat a rejected native RPC command as success", async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: false, message: "The native request expired" });
    await rejectsWithMessage(createCloudRpcApi(rpc).respond(jobId, requestId, response), "The native request expired");
  });
});
