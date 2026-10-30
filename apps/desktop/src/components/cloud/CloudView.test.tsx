import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CloudJob, CloudJobDetail, CloudSettings, CloudSourcePreview, ConversationItem, InteractiveRequest, WorkspaceSummary } from "@falcondeck/client-core";
import { CloudView, type CloudOwner } from "./CloudView";
import type { CloudApi } from "./cloud-api";

vi.mock("@falcondeck/chat-ui", async (importOriginal) => ({
  ...await importOriginal<typeof import("@falcondeck/chat-ui")>(),
  Conversation: ({ items }: { items: ConversationItem[] }) => <div aria-label="Native conversation">{items.map((item) => <p key={item.id}>{"text" in item ? item.text : item.kind}</p>)}</div>,
}));

const createdAt = "2026-10-30T10:00:00Z";
const settings: CloudSettings = {
  enabled: true,
  has_provider_token: true,
  has_openai_api_key: true,
  team_id: null,
  project_id: null,
  image: "node24",
  timeout_minutes: 15,
  node_binary: "node",
  runtime_path: "/opt/cloud-runtime.mjs",
  worker_daemon_url: "https://downloads.test/daemon",
  worker_daemon_sha256: "a".repeat(64),
  allowed_domains: ["api.openai.com"],
};

function workspace(id = "local-project", kind: WorkspaceSummary["kind"] = "project"): WorkspaceSummary {
  return {
    id, kind, path: `/source/${id}`, status: "ready", agents: [], models: [],
    collaboration_modes: [], account: { status: "ready", label: "Ready" },
    current_thread_id: null, connected_at: createdAt, updated_at: createdAt, last_error: null,
  } as WorkspaceSummary;
}

function source(workspaceId = "local-project", id = "reviewed-source"): CloudSourcePreview {
  return {
    id, workspace_id: workspaceId, base_head: "base-commit", tree_hash: "current-tree-with-local-edits",
    included_paths: ["src/modified.ts", "src/new-file.ts"], excluded_paths: [".env.local", "node_modules/"],
    total_bytes: 2048, created_at: createdAt,
  };
}

function job(overrides: Partial<CloudJob> = {}): CloudJob {
  return {
    id: "cloud-job", workspace_id: "local-project", source: source(), status: "provisioning",
    prompt: "Repair the source", model_id: null, worker: null, result: null, error: null,
    created_at: createdAt, updated_at: createdAt, expires_at: null, ...overrides,
  };
}

function cloudApi(overrides: Partial<CloudApi> = {}) {
  return Object.assign({
    settings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue(settings),
    capture: vi.fn().mockImplementation(async (workspaceId: string) => source(workspaceId)),
    jobs: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(job()),
    job: vi.fn().mockResolvedValue(job()),
    detail: vi.fn().mockRejectedValue(new Error("Native worker not ready")),
    sendTurn: vi.fn().mockResolvedValue({ ok: true }),
    interrupt: vi.fn().mockResolvedValue({ ok: true }),
    respond: vi.fn().mockResolvedValue({ ok: true }),
    collect: vi.fn().mockResolvedValue(job()),
    importResult: vi.fn().mockResolvedValue(job()),
    stop: vi.fn().mockResolvedValue(job({ status: "stopped" })),
    resume: vi.fn().mockResolvedValue(job({ status: "running" })),
  }, overrides);
}

function owner(api: CloudApi | null, id = "local", workspaces = [workspace()]): CloudOwner {
  return { id, label: id === "local" ? "This Mac" : "Remote build host", api, workspaces };
}

function openNewTask() {
  fireEvent.click(screen.getAllByRole("button", { name: "New cloud task" })[0]);
}

async function ready() {
  await waitFor(() => expect(screen.queryByText("Loading cloud tasks…")).not.toBeInTheDocument());
}

function nativeRequest(): InteractiveRequest {
  return {
    request_id: "native-approval", workspace_id: "worker-workspace", thread_id: "native-task", method: "item/commandExecution/requestApproval",
    kind: "approval", approval_decisions: ["allow", "deny"], title: "Run tests?", detail: "The native task needs permission.", command: "npm test", path: null,
    turn_id: "native-turn", item_id: "native-item", questions: [], created_at: createdAt,
  };
}

function nativeDetail(overrides: Partial<CloudJobDetail> = {}): CloudJobDetail {
  return {
    workspace: workspace("worker-workspace"), thread: { title: "Native worker task" },
    items: [{ kind: "assistant_message", id: "native-message", text: "Ready to run the tests", created_at: createdAt }],
    interactive_requests: [nativeRequest()], has_older: false, is_partial: false, oldest_item_id: "native-message", newest_item_id: "native-message",
    is_live: true, collected_at: null, ...overrides,
  } as CloudJobDetail;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("CloudView reviewed source admission", () => {
  it("requires a prompt and reviewed capture, and shows local file changes and exclusions before sending", async () => {
    const api = cloudApi();
    render(<CloudView owners={[owner(api)]} onClose={vi.fn()} />);
    await ready();
    openNewTask();
    const send = screen.getByRole("button", { name: "Send reviewed source" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Task instructions"), { target: { value: "Repair the current edits" } });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview current source" }));
    await screen.findByText("Source current-tree-with-local-edits");
    fireEvent.click(screen.getByText("Files to send (2)"));
    fireEvent.click(screen.getByText("Excluded files (2)"));
    expect(screen.getByText("src/modified.ts")).toBeVisible();
    expect(screen.getByText("src/new-file.ts")).toBeVisible();
    expect(screen.getByText(".env.local")).toBeVisible();
    expect(screen.getByText("node_modules/")).toBeVisible();
    expect(api.capture).toHaveBeenCalledWith("local-project");
    expect(send).toBeEnabled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("retries uncertain admission with the exact reviewed capture and the same idempotency key", async () => {
    const api = cloudApi();
    api.create.mockRejectedValueOnce(new Error("Admission timed out; inspect before retrying"));
    render(<CloudView owners={[owner(api)]} onClose={vi.fn()} />);
    await ready();
    openNewTask();
    fireEvent.change(screen.getByLabelText("Task instructions"), { target: { value: "  Repair these current edits  " } });
    fireEvent.click(screen.getByRole("button", { name: "Preview current source" }));
    await screen.findByRole("button", { name: "Refresh source preview" });
    fireEvent.click(screen.getByRole("button", { name: "Send reviewed source" }));
    await screen.findByRole("alert");
    const first = api.create.mock.calls[0][0];
    expect(first).toEqual({
      workspace_id: "local-project", prompt: "Repair these current edits", source_capture_id: "reviewed-source",
      idempotency_key: expect.any(String),
    });
    expect(first.idempotency_key).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Send reviewed source" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    expect(api.create.mock.calls[1][0]).toEqual(first);
    expect(api.capture).toHaveBeenCalledTimes(1);
    await screen.findByRole("button", { name: "All cloud tasks" });
  });

  it("discards the reviewed capture when the source project changes", async () => {
    const api = cloudApi();
    render(<CloudView owners={[owner(api, "local", [workspace(), workspace("second-project")])]} onClose={vi.fn()} />);
    await ready();
    openNewTask();
    fireEvent.change(screen.getByLabelText("Task instructions"), { target: { value: "Repair the first project" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview current source" }));
    await screen.findByRole("button", { name: "Refresh source preview" });
    fireEvent.change(screen.getByLabelText("Source project"), { target: { value: "second-project" } });
    expect(screen.getByRole("button", { name: "Send reviewed source" })).toBeDisabled();
    expect(screen.queryByText("Source current-tree-with-local-edits")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview current source" }));
    await waitFor(() => expect(api.capture).toHaveBeenLastCalledWith("second-project"));
    expect(api.create).not.toHaveBeenCalled();
  });

  it("selects a source project when chats precede projects in the host snapshot", async () => {
    const api = cloudApi();
    render(<CloudView owners={[owner(api, "local", [workspace("chat", "casual"), workspace()])]} onClose={vi.fn()} />);
    await ready();
    expect(screen.getByLabelText("Source project")).toHaveValue("local-project");
    openNewTask();
    fireEvent.click(screen.getByRole("button", { name: "Preview current source" }));
    await waitFor(() => expect(api.capture).toHaveBeenCalledWith("local-project"));
  });
});

describe("CloudView host ownership", () => {
  it("honors the selected owner when local and remote hosts share the same workspace identifier", async () => {
    const local = cloudApi();
    const remote = cloudApi();
    render(<CloudView owners={[owner(local), owner(remote, "remote", [workspace()])]} initialWorkspaceId="local-project" initialOwnerId="remote" onClose={vi.fn()} />);
    await ready();
    expect(screen.getByLabelText("Source host")).toHaveValue("remote");
    expect(remote.settings).toHaveBeenCalledTimes(1);
    expect(remote.jobs).toHaveBeenCalledTimes(1);
    openNewTask();
    fireEvent.change(screen.getByLabelText("Task instructions"), { target: { value: "Repair the source on the selected host" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview current source" }));
    await screen.findByRole("button", { name: "Refresh source preview" });
    fireEvent.click(screen.getByRole("button", { name: "Send reviewed source" }));
    await waitFor(() => expect(remote.create).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: "local-project", source_capture_id: "reviewed-source" })));
    expect(local.settings).not.toHaveBeenCalled();
    expect(local.jobs).not.toHaveBeenCalled();
    expect(local.capture).not.toHaveBeenCalled();
    expect(local.create).not.toHaveBeenCalled();
  });

  it("keeps a persisted sandbox manageable after its original source project has been removed", async () => {
    const orphan = job({ workspace_id: "removed-source-project", status: "running" });
    const api = cloudApi({ jobs: vi.fn().mockResolvedValue([orphan]), job: vi.fn().mockResolvedValue(orphan) });
    render(<CloudView owners={[owner(api)]} onClose={vi.fn()} />);
    await ready();
    expect(screen.getByLabelText("Source project")).toHaveValue("local-project");
    const task = screen.getByRole("button", { name: /Repair the source/ });
    expect(task).toHaveTextContent("removed-source-project");
    fireEvent.click(task);
    fireEvent.click(await screen.findByRole("button", { name: "Stop sandbox…" }));
    expect(screen.getByRole("group", { name: "Confirm sandbox stop" })).toBeInTheDocument();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("loads and creates only on the host that owns the initially selected source project", async () => {
    const local = cloudApi();
    const remote = cloudApi();
    render(<CloudView owners={[owner(local), owner(remote, "remote", [workspace("remote-project")])]} initialWorkspaceId="remote-project" onClose={vi.fn()} />);
    await ready();
    expect(screen.getByLabelText("Source host")).toHaveValue("remote");
    expect(screen.getByLabelText("Source project")).toHaveValue("remote-project");
    expect(remote.settings).toHaveBeenCalledTimes(1);
    expect(local.settings).not.toHaveBeenCalled();
    openNewTask();
    fireEvent.change(screen.getByLabelText("Task instructions"), { target: { value: "Fix the remote source" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview current source" }));
    await screen.findByRole("button", { name: "Refresh source preview" });
    fireEvent.click(screen.getByRole("button", { name: "Send reviewed source" }));
    await waitFor(() => expect(remote.create).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: "remote-project", source_capture_id: "reviewed-source" })));
    expect(local.capture).not.toHaveBeenCalled();
    expect(local.create).not.toHaveBeenCalled();
  });

  it("shows a remote capture failure without falling back to the local host", async () => {
    const local = cloudApi();
    const remote = cloudApi();
    remote.capture.mockRejectedValue(new Error("Remote source host disconnected"));
    render(<CloudView owners={[owner(local), owner(remote, "remote", [workspace("remote-project")])]} initialWorkspaceId="remote-project" onClose={vi.fn()} />);
    await ready();
    openNewTask();
    fireEvent.change(screen.getByLabelText("Task instructions"), { target: { value: "Repair the source" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview current source" }));
    await screen.findByText("Remote source host disconnected");
    expect(screen.getByRole("button", { name: "Send reviewed source" })).toBeDisabled();
    expect(local.capture).not.toHaveBeenCalled();
    expect(local.create).not.toHaveBeenCalled();
    expect(remote.create).not.toHaveBeenCalled();
  });

  it("clears the previous host's source preview when switching hosts", async () => {
    const local = cloudApi();
    const remote = cloudApi();
    render(<CloudView owners={[owner(local), owner(remote, "remote", [workspace("remote-project")])]} onClose={vi.fn()} />);
    await ready();
    openNewTask();
    fireEvent.click(screen.getByRole("button", { name: "Preview current source" }));
    await screen.findByRole("button", { name: "Refresh source preview" });
    fireEvent.change(screen.getByLabelText("Source host"), { target: { value: "remote" } });
    await ready();
    expect(screen.getByLabelText("Source project")).toHaveValue("remote-project");
    openNewTask();
    expect(screen.queryByText("Source current-tree-with-local-edits")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reviewed source" })).toBeDisabled();
    expect(remote.capture).not.toHaveBeenCalled();
  });
});

describe("CloudView result and native task controls", () => {
  it("collects only on demand and requires separate explicit import and sandbox stop confirmations", async () => {
    let current = job({ status: "completed" });
    const result = {
      collected_at: createdAt, tree_hash: "result-tree", changed_paths: ["src/fixed.ts"], deleted_paths: ["src/obsolete.ts"], native_session_count: 1, imported_at: null,
    };
    const api = cloudApi({
      jobs: vi.fn().mockResolvedValue([current]),
      job: vi.fn().mockImplementation(async () => current),
      collect: vi.fn().mockImplementation(async () => { current = { ...current, result }; return current; }),
      importResult: vi.fn().mockImplementation(async () => { current = { ...current, result: { ...result, imported_at: createdAt } }; return current; }),
      stop: vi.fn().mockImplementation(async () => { current = { ...current, status: "stopped" }; return current; }),
    });
    render(<CloudView owners={[owner(api)]} onClose={vi.fn()} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Repair the source/ }));
    await screen.findByRole("button", { name: "Collect result" });
    expect(api.collect).not.toHaveBeenCalled();
    expect(api.importResult).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Import result…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Collect result" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import result…" })).toBeEnabled());
    expect(api.collect).toHaveBeenCalledWith("cloud-job");
    expect(api.importResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import result…" }));
    let confirmation = screen.getByRole("group", { name: "Confirm result import" });
    expect(within(confirmation).getByText(/Import will be refused if the source changed since capture/)).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(api.importResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import result…" }));
    confirmation = screen.getByRole("group", { name: "Confirm result import" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Import into source project" }));
    await waitFor(() => expect(api.importResult).toHaveBeenCalledWith("cloud-job"));
    await screen.findByRole("button", { name: "Imported" });
    fireEvent.click(screen.getByRole("button", { name: "Stop sandbox…" }));
    const stopConfirmation = screen.getByRole("group", { name: "Confirm sandbox stop" });
    expect(api.stop).not.toHaveBeenCalled();
    fireEvent.click(within(stopConfirmation).getByRole("button", { name: "Stop sandbox" }));
    await waitFor(() => expect(api.stop).toHaveBeenCalledWith("cloud-job"));
    await screen.findByText("Stopped");
  });

  it("renders worker native items and keeps failed native approval responses visible", async () => {
    const current = job({ status: "awaiting_input", worker: { workspace_id: "worker-workspace", thread_id: "native-task", provider: "codex" } });
    const detail = nativeDetail();
    const api = cloudApi({ jobs: vi.fn().mockResolvedValue([current]), job: vi.fn().mockResolvedValue(current), detail: vi.fn().mockResolvedValue(detail) });
    api.respond.mockRejectedValue(new Error("The native approval expired"));
    render(<CloudView owners={[owner(api)]} onClose={vi.fn()} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Repair the source/ }));
    await screen.findByText("Ready to run the tests");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await screen.findByText("The native approval expired");
    expect(api.respond).toHaveBeenCalledWith("cloud-job", "native-approval", { kind: "approval", decision: "allow" });
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("does not restore a resolved native approval when an older poll finishes after the response", async () => {
    const awaiting = job({ status: "awaiting_input", worker: { workspace_id: "worker-workspace", thread_id: "native-task", provider: "codex" } });
    let answered = false;
    let detailReads = 0;
    const oldDetail = deferred<CloudJobDetail>();
    const api = cloudApi({
      jobs: vi.fn().mockResolvedValue([awaiting]),
      job: vi.fn().mockImplementation(async () => answered ? { ...awaiting, status: "running" } : awaiting),
      detail: vi.fn().mockImplementation(async () => {
        detailReads += 1;
        return detailReads === 2 ? oldDetail.promise : nativeDetail({ interactive_requests: answered ? [] : [nativeRequest()] });
      }),
      respond: vi.fn().mockImplementation(async () => { answered = true; return { ok: true }; }),
    });
    render(<CloudView owners={[owner(api)]} onClose={vi.fn()} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Repair the source/ }));
    await screen.findByRole("button", { name: "Allow" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh cloud task" }));
    await waitFor(() => expect(detailReads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(api.respond).toHaveBeenCalledWith("cloud-job", "native-approval", { kind: "approval", decision: "allow" }));
    await screen.findByText("Running");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument());
    expect(detailReads).toBe(3);
    await act(async () => {
      oldDetail.resolve(nativeDetail());
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    expect(screen.queryByText("1 response pending")).not.toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(api.respond).toHaveBeenCalledTimes(1);
  });

  it("shows a collected native transcript after stop without enabling stale approvals or follow-up turns", async () => {
    const current = job({ status: "stopped", worker: { workspace_id: "worker-workspace", thread_id: "native-task", provider: "codex" } });
    const detail = nativeDetail({ is_live: false, collected_at: createdAt });
    const api = cloudApi({ jobs: vi.fn().mockResolvedValue([current]), job: vi.fn().mockResolvedValue(current), detail: vi.fn().mockResolvedValue(detail) });
    render(<CloudView owners={[owner(api)]} onClose={vi.fn()} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Repair the source/ }));
    await screen.findByText("Ready to run the tests");
    expect(screen.getByText(/Collected native task/)).toHaveTextContent("Live controls are unavailable");
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Follow-up instructions")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(api.respond).not.toHaveBeenCalled();
    expect(api.sendTurn).not.toHaveBeenCalled();
  });

  it("resumes a stopped sandbox after collection only on an explicit click, retaining its native task identity", async () => {
    const worker = { workspace_id: "worker-workspace", thread_id: "native-task", provider: "codex" };
    let current = job({ status: "stopped", worker, result: {
      collected_at: createdAt, tree_hash: "saved-result", changed_paths: ["src/fixed.ts"], deleted_paths: [], native_session_count: 1, imported_at: null,
    } });
    const api = cloudApi({
      jobs: vi.fn().mockResolvedValue([current]), job: vi.fn().mockImplementation(async () => current),
      detail: vi.fn().mockImplementation(async () => nativeDetail({ is_live: current.status === "running", collected_at: current.status === "running" ? null : createdAt })),
      resume: vi.fn().mockImplementation(async () => { current = { ...current, status: "running", result: null }; return current; }),
    });
    render(<CloudView owners={[owner(api)]} onClose={vi.fn()} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Repair the source/ }));
    const resume = await screen.findByRole("button", { name: "Resume existing sandbox" });
    expect(api.resume).not.toHaveBeenCalled();
    expect(screen.getByText(/Collected result/)).toBeInTheDocument();
    fireEvent.click(resume);
    await waitFor(() => expect(api.resume).toHaveBeenCalledWith("cloud-job"));
    await screen.findByText("Running");
    await waitFor(() => expect(screen.getByLabelText("Follow-up instructions")).toBeEnabled());
    fireEvent.click(screen.getByText("Native codex task"));
    expect(screen.getByText(/Workspace: worker-workspace/)).toHaveTextContent("Task: native-task");
    expect(api.create).not.toHaveBeenCalled();
    expect(api.capture).not.toHaveBeenCalled();
  });

  it.each(["job", "detail"] as const)("ignores a stale pre-stop %s refresh after the sandbox has stopped", async (stage) => {
    const running = job({ status: "running", worker: { workspace_id: "worker-workspace", thread_id: "native-task", provider: "codex" } });
    let current = running;
    const pendingJob = deferred<CloudJob>();
    const pendingDetail = deferred<CloudJobDetail>();
    let jobReads = 0;
    let detailReads = 0;
    const api = cloudApi({
      jobs: vi.fn().mockResolvedValue([current]),
      job: vi.fn().mockImplementation(async () => {
        jobReads += 1;
        return stage === "job" && jobReads === 2 ? pendingJob.promise : current;
      }),
      detail: vi.fn().mockImplementation(async () => {
        detailReads += 1;
        return stage === "detail" && detailReads === 2 ? pendingDetail.promise : nativeDetail({ is_live: current.status === "running", collected_at: current.status === "running" ? null : createdAt });
      }),
      stop: vi.fn().mockImplementation(async () => { current = { ...current, status: "stopped" }; return current; }),
    });
    render(<CloudView owners={[owner(api)]} onClose={vi.fn()} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /Repair the source/ }));
    await screen.findByRole("button", { name: "Allow" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh cloud task" }));
    await waitFor(() => expect(stage === "job" ? jobReads : detailReads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Stop sandbox…" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm sandbox stop" })).getByRole("button", { name: "Stop sandbox" }));
    await screen.findByText("Stopped");
    await screen.findByText(/Collected native task/);
    await act(async () => {
      if (stage === "job") pendingJob.resolve(running);
      else pendingDetail.resolve(nativeDetail());
      await Promise.resolve();
    });
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Follow-up instructions")).toBeDisabled();
    expect(api.respond).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });
});
