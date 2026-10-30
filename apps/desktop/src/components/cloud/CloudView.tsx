import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, Plus, RefreshCw, Settings } from "lucide-react";
import { Conversation, InteractiveRequestBar } from "@falcondeck/chat-ui";
import type {
  CloudJob,
  CloudJobDetail,
  CloudJobStatus,
  CloudSettings,
  CloudSourcePreview,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  MainView,
  MainViewBody,
  MainViewLead,
  MainViewSection,
  Textarea,
  cn,
} from "@falcondeck/ui";
import type { CloudApi } from "./cloud-api";
import { CloudSettingsForm } from "./CloudSettingsForm";

export type CloudOwner = {
  id: string;
  label: string;
  workspaces: WorkspaceSummary[];
  api: CloudApi | null;
};
export type CloudViewProps = {
  owners: CloudOwner[];
  initialOwnerId?: string | null;
  initialWorkspaceId?: string | null;
  onClose: () => void;
};
const selectClass =
  "fd-focus h-9 w-full rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 px-3 text-sm text-fg-primary";
const statusLabels: Record<CloudJobStatus, string> = {
  provisioning: "Starting",
  running: "Running",
  awaiting_input: "Needs input",
  completed: "Completed",
  failed: "Failed",
  unknown: "Outcome unknown",
  stopping: "Stopping",
  stopped: "Stopped",
  expired: "Expired",
};
function Status({ status }: { status: CloudJobStatus }) {
  const variant =
    status === "failed"
      ? "danger"
      : status === "awaiting_input" || status === "unknown"
        ? "warning"
        : status === "running" || status === "provisioning"
          ? "info"
          : status === "completed"
            ? "success"
            : "default";
  return <Badge variant={variant}>{statusLabels[status] ?? status}</Badge>;
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "The cloud request failed.";
}
function SourcePreview({ source }: { source: CloudSourcePreview }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-fg-secondary">
        {source.included_paths.length} files ·{" "}
        {(source.total_bytes / 1024).toFixed(1)} KB · captured{" "}
        {new Date(source.created_at).toLocaleString()}
      </p>
      <p className="break-all font-mono text-xs text-fg-muted">
        Source {source.tree_hash}
      </p>
      <details>
        <summary className="fd-focus cursor-pointer text-fg-secondary">
          Files to send ({source.included_paths.length})
        </summary>
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-[var(--fd-radius-md)] bg-surface-2 p-3 font-mono text-xs text-fg-secondary">
          {source.included_paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      </details>
      <details>
        <summary className="fd-focus cursor-pointer text-fg-secondary">
          Excluded files ({source.excluded_paths.length})
        </summary>
        <ul className="mt-2 max-h-48 overflow-y-auto rounded-[var(--fd-radius-md)] bg-surface-2 p-3 font-mono text-xs text-fg-muted">
          {source.excluded_paths.length ? (
            source.excluded_paths.map((path) => <li key={path}>{path}</li>)
          ) : (
            <li>No excluded files.</li>
          )}
        </ul>
      </details>
    </div>
  );
}

export function CloudView({
  owners,
  initialOwnerId,
  initialWorkspaceId,
  onClose,
}: CloudViewProps) {
  const [ownerId, setOwnerId] = useState(
    () =>
      owners.find((owner) => owner.id === initialOwnerId)?.id ??
      owners.find((owner) =>
        owner.workspaces.some(
          (workspace) => workspace.id === initialWorkspaceId,
        ),
      )?.id ??
      owners[0]?.id ??
      "local",
  );
  const owner =
    owners.find((candidate) => candidate.id === ownerId) ?? owners[0];
  const [page, setPage] = useState<"tasks" | "new" | "settings">("tasks");
  return (
    <MainView
      icon={<Cloud aria-hidden className="h-5 w-5" />}
      title="Cloud tasks"
      meta={owner?.label}
      onClose={onClose}
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPage(page === "settings" ? "tasks" : "settings")}
            aria-label="Cloud settings"
          >
            <Settings aria-hidden className="h-4 w-4" />
            Settings
          </Button>
          <Button size="sm" onClick={() => setPage("new")}>
            <Plus aria-hidden className="h-4 w-4" />
            New cloud task
          </Button>
        </>
      }
    >
      <div className="border-b border-border-subtle px-6 py-3">
        <Field label="Source host" htmlFor="cloud-source-host">
          <select
            id="cloud-source-host"
            className={cn(selectClass, "max-w-sm")}
            value={owner?.id ?? ""}
            onChange={(event) => {
              setOwnerId(event.target.value);
              setPage("tasks");
            }}
          >
            {owners.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {owner ? (
        <CloudOwnerView
          key={owner.id}
          owner={owner}
          initialWorkspaceId={initialWorkspaceId}
          page={page}
          onPage={setPage}
        />
      ) : (
        <MainViewBody>
          <p role="alert" className="text-sm text-danger">
            No source host is available.
          </p>
        </MainViewBody>
      )}
    </MainView>
  );
}

function CloudOwnerView({
  owner,
  initialWorkspaceId,
  page,
  onPage,
}: {
  owner: CloudOwner;
  initialWorkspaceId?: string | null;
  page: "tasks" | "new" | "settings";
  onPage: (page: "tasks" | "new" | "settings") => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(
    () =>
      owner.workspaces.find(
        (workspace) =>
          workspace.id === initialWorkspaceId && workspace.kind !== "casual",
      )?.id ??
      owner.workspaces.find((workspace) => workspace.kind !== "casual")?.id ??
      "",
  );
  const [settings, setSettings] = useState<CloudSettings | null>(null);
  const [jobs, setJobs] = useState<CloudJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<CloudJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const api = owner.api;
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    if (!api) {
      setLoading(false);
      setError("Connect to this host to manage its cloud tasks.");
      return;
    }
    try {
      const [nextSettings, nextJobs] = await Promise.all([
        api.settings(),
        api.jobs(),
      ]);
      if (request !== sequence.current) return;
      setSettings(nextSettings);
      setJobs(nextJobs);
      setError(null);
    } catch (reason) {
      if (request === sequence.current) setError(message(reason));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (page !== "tasks") setSelectedJob(null);
  }, [page]);
  const updateJob = (job: CloudJob) => {
    setJobs((current) => [
      job,
      ...current.filter((entry) => entry.id !== job.id),
    ]);
    setSelectedJob(job);
  };
  const selectedWorkspace = owner.workspaces.find(
    (workspace) => workspace.id === workspaceId,
  );
  if (selectedJob && api && page === "tasks")
    return (
      <CloudJobView
        key={selectedJob.id}
        api={api}
        initialJob={selectedJob}
        workspacePath={
          owner.workspaces.find(
            (workspace) => workspace.id === selectedJob.workspace_id,
          )?.path ?? "Original source project"
        }
        onChange={updateJob}
        onBack={() => {
          setSelectedJob(null);
          void load();
        }}
      />
    );
  return (
    <MainViewBody>
      <div className="space-y-6">
        {error ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 text-sm text-danger"
          >
            <span>{error}</span>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : null}
        {loading ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading cloud tasks…
          </p>
        ) : null}
        {page === "settings" ? (
          settings && api ? (
            <CloudSettingsForm
              key={owner.id}
              api={api}
              settings={settings}
              onSaved={setSettings}
            />
          ) : null
        ) : (
          <>
            <MainViewLead>
              Run Codex from a reviewed snapshot of your current source,
              including eligible local changes. Collect the result and
              explicitly import it when ready.
            </MainViewLead>
            <Field
              label="Source project"
              htmlFor="cloud-source-project"
              hint={selectedWorkspace?.path}
            >
              <select
                id="cloud-source-project"
                className={selectClass}
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
              >
                <option value="" disabled>
                  Select a source project
                </option>
                {owner.workspaces
                  .filter((workspace) => workspace.kind !== "casual")
                  .map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.path}
                    </option>
                  ))}
              </select>
            </Field>
            {page === "new" && api ? (
              <NewCloudTask
                key={workspaceId}
                api={api}
                workspaceId={selectedWorkspace?.id ?? ""}
                settings={settings}
                onConfigure={() => onPage("settings")}
                onCreated={(job) => {
                  updateJob(job);
                  onPage("tasks");
                }}
                onCancel={() => onPage("tasks")}
              />
            ) : (
              <MainViewSection
                title="Tasks"
                count={jobs.length}
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Refresh cloud tasks"
                    onClick={() => void load()}
                  >
                    <RefreshCw aria-hidden className="h-4 w-4" />
                  </Button>
                }
              >
                {!loading && jobs.length === 0 ? (
                  <EmptyState
                    icon={<Cloud className="h-6 w-6" />}
                    title="No cloud tasks"
                    description="Select a source project and start a cloud task."
                    action={
                      <Button size="sm" onClick={() => onPage("new")}>
                        New cloud task
                      </Button>
                    }
                  />
                ) : (
                  <div className="divide-y divide-border-subtle border-y border-border-subtle">
                    {jobs.map((job) => (
                      <button
                        type="button"
                        key={job.id}
                        className="fd-focus flex w-full items-start justify-between gap-4 px-3 py-4 text-left hover:bg-interactive-hover"
                        onClick={() => setSelectedJob(job)}
                      >
                        <span className="min-w-0 space-y-1">
                          <span className="block truncate text-sm font-medium text-fg-primary">
                            {job.prompt}
                          </span>
                          <span className="block text-xs text-fg-muted">
                            {owner.workspaces.find(
                              (workspace) => workspace.id === job.workspace_id,
                            )?.path ?? job.workspace_id}{" "}
                            · {new Date(job.created_at).toLocaleString()}
                          </span>
                          {job.error ? (
                            <span className="block text-xs text-danger">
                              {job.error}
                            </span>
                          ) : null}
                        </span>
                        <Status status={job.status} />
                      </button>
                    ))}
                  </div>
                )}
              </MainViewSection>
            )}
          </>
        )}
      </div>
    </MainViewBody>
  );
}

function NewCloudTask({
  api,
  workspaceId,
  settings,
  onConfigure,
  onCreated,
  onCancel,
}: {
  api: CloudApi;
  workspaceId: string;
  settings: CloudSettings | null;
  onConfigure: () => void;
  onCreated: (job: CloudJob) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [source, setSource] = useState<CloudSourcePreview | null>(null);
  const [busy, setBusy] = useState<"capture" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retryKey = useRef<string | null>(null);
  const configured =
    settings?.enabled &&
    settings.has_provider_token &&
    settings.has_openai_api_key;
  async function capture() {
    if (busy) return;
    setBusy("capture");
    setError(null);
    try {
      setSource(await api.capture(workspaceId));
      retryKey.current = null;
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(null);
    }
  }
  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !source || !prompt.trim()) return;
    retryKey.current ??= crypto.randomUUID();
    setBusy("start");
    setError(null);
    try {
      onCreated(
        await api.create({
          workspace_id: workspaceId,
          prompt: prompt.trim(),
          source_capture_id: source.id,
          idempotency_key: retryKey.current,
        }),
      );
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>New cloud task</CardTitle>
        <CardDescription>
          Review the exact source before sending it to a billable sandbox.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void start(event)} className="space-y-5">
          {!configured ? (
            <p className="text-sm text-warning">
              Cloud tasks need an enabled host with saved Vercel and OpenAI
              credentials.{" "}
              <button
                type="button"
                onClick={onConfigure}
                className="fd-focus underline"
              >
                Open cloud settings
              </button>
            </p>
          ) : null}
          <Field label="Task instructions" htmlFor="cloud-prompt">
            <Textarea
              id="cloud-prompt"
              rows={5}
              required
              value={prompt}
              disabled={Boolean(busy)}
              placeholder="Describe the change to make…"
              onChange={(event) => {
                setPrompt(event.target.value);
                retryKey.current = null;
              }}
            />
          </Field>
          <div className="space-y-3">
            <Button
              type="button"
              variant="secondary"
              disabled={!workspaceId || Boolean(busy)}
              onClick={() => void capture()}
            >
              {busy === "capture"
                ? "Capturing source…"
                : source
                  ? "Refresh source preview"
                  : "Preview current source"}
            </Button>
            {source ? (
              <SourcePreview source={source} />
            ) : (
              <p className="text-xs text-fg-muted">
                Capture your current project to inspect included and excluded
                files before sending.
              </p>
            )}
          </div>
          {source ? (
            <p className="text-xs text-fg-muted">
              The task uses this saved capture. Refresh the preview to include
              newer edits.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              disabled={
                !configured ||
                !workspaceId ||
                !source ||
                !prompt.trim() ||
                Boolean(busy)
              }
            >
              {busy === "start"
                ? "Starting cloud task…"
                : "Send reviewed source"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function CloudJobView({
  api,
  initialJob,
  workspacePath,
  onChange,
  onBack,
}: {
  api: CloudApi;
  initialJob: CloudJob;
  workspacePath: string;
  onChange: (job: CloudJob) => void;
  onBack: () => void;
}) {
  const [job, setJob] = useState(initialJob);
  const [detail, setDetail] = useState<CloudJobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");
  const [confirm, setConfirm] = useState<"import" | "stop" | null>(null);
  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);
  const jobRef = useRef(initialJob);
  const alive = useRef(true);
  const refreshVersion = useRef(0);
  const refreshing = useRef<number | null>(null);
  const mutating = useRef(false);
  const update = useCallback((next: CloudJob) => {
    if (alive.current) {
      jobRef.current = next;
      setJob(next);
      changeRef.current(next);
    }
  }, []);
  const refresh = useCallback(
    async (force = false) => {
      if (!force && (refreshing.current !== null || mutating.current)) return;
      const version = ++refreshVersion.current;
      refreshing.current = version;
      try {
        const next = await api.job(initialJob.id);
        if (!alive.current || refreshVersion.current !== version) return;
        update(next);
        if (next.worker) {
          try {
            const nextDetail = await api.detail(next.id);
            if (alive.current && refreshVersion.current === version) {
              setDetail(nextDetail);
              setDetailError(null);
            }
          } catch (reason) {
            if (alive.current && refreshVersion.current === version)
              setDetailError(message(reason));
          }
        }
      } catch (reason) {
        if (alive.current && refreshVersion.current === version)
          setError(message(reason));
      } finally {
        if (refreshing.current === version) refreshing.current = null;
      }
    },
    [api, initialJob.id, update],
  );
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (
        !document.hidden &&
        !["stopped", "expired"].includes(jobRef.current.status)
      )
        void refresh();
    }, 4000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);
  async function action(name: string, operation: () => Promise<unknown>) {
    if (mutating.current) return;
    mutating.current = true;
    refreshVersion.current += 1;
    setBusy(name);
    setError(null);
    try {
      const result = await operation();
      if (result && typeof result === "object" && "status" in result)
        update(result as CloudJob);
      setConfirm(null);
      await refresh(true);
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      mutating.current = false;
      setBusy(null);
    }
  }
  const pending = detail?.is_live ? detail.interactive_requests : [];
  const canContinue =
    detail?.is_live &&
    ["running", "awaiting_input", "completed"].includes(job.status);
  const canCollect = ["completed", "failed"].includes(job.status);
  const canStop = !["stopped", "expired", "stopping"].includes(job.status);
  const canResume =
    ["stopped", "expired"].includes(job.status) && Boolean(job.worker);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-border-subtle px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            All cloud tasks
          </Button>
          <Status status={job.status} />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh cloud task"
            disabled={Boolean(busy)}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-sm font-medium text-fg-primary">{job.prompt}</p>
        <p className="truncate text-xs text-fg-muted">
          Source: {workspacePath}
          {job.expires_at
            ? ` · Expires ${new Date(job.expires_at).toLocaleString()}`
            : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!canCollect || Boolean(busy)}
            onClick={() => void action("collect", () => api.collect(job.id))}
          >
            {busy === "collect" ? "Collecting…" : "Collect result"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={
              !job.result ||
              Boolean(job.result.imported_at) ||
              Boolean(busy) ||
              !["completed", "failed", "stopped", "expired"].includes(
                job.status,
              )
            }
            onClick={() => setConfirm("import")}
          >
            {job.result?.imported_at ? "Imported" : "Import result…"}
          </Button>
          {job.status === "running" || job.status === "awaiting_input" ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={Boolean(busy)}
              onClick={() =>
                void action("interrupt", () => api.interrupt(job.id))
              }
            >
              Interrupt turn
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={!canStop || Boolean(busy)}
            onClick={() => setConfirm("stop")}
          >
            Stop sandbox…
          </Button>
          {canResume ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => void action("resume", () => api.resume(job.id))}
            >
              {busy === "resume" ? "Resuming…" : "Resume existing sandbox"}
            </Button>
          ) : null}
        </div>
        {confirm ? (
          <div
            className="space-y-3 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 p-3"
            role="group"
            aria-label={
              confirm === "import"
                ? "Confirm result import"
                : "Confirm sandbox stop"
            }
          >
            <p className="text-sm text-fg-secondary">
              {confirm === "import"
                ? `Apply the collected changed and deleted files to ${workspacePath}? Import will be refused if the source changed since capture.`
                : job.result
                  ? "Stop and save this sandbox for up to 24 hours? The collected result stays available on this host."
                  : "Stop and save this sandbox for up to 24 hours? Collect a result first to retain source changes and native history on this host beyond that window."}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={Boolean(busy)}
                onClick={() =>
                  void action(confirm, () =>
                    confirm === "import"
                      ? api.importResult(job.id)
                      : api.stop(job.id),
                  )
                }
              >
                {busy
                  ? "Working…"
                  : confirm === "import"
                    ? "Import into source project"
                    : "Stop sandbox"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {job.result ? (
          <details className="text-sm text-fg-secondary">
            <summary className="fd-focus cursor-pointer">
              Collected result · {job.result.changed_paths.length} changed ·{" "}
              {job.result.deleted_paths.length} deleted ·{" "}
              {job.result.native_session_count} native sessions
            </summary>
            <ul className="mt-2 max-h-40 overflow-y-auto font-mono text-xs">
              {job.result.changed_paths.map((path) => (
                <li key={path}>Changed: {path}</li>
              ))}
              {job.result.deleted_paths.map((path) => (
                <li key={path}>Deleted: {path}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {job.worker ? (
          <details className="text-xs text-fg-muted">
            <summary className="fd-focus cursor-pointer">
              Native {job.worker.provider} task
            </summary>
            <p className="mt-2 break-all font-mono">
              Workspace: {job.worker.workspace_id}
              <br />
              Task: {job.worker.thread_id}
            </p>
          </details>
        ) : null}
        {detail && !detail.is_live ? (
          <p className="text-xs text-fg-muted">
            Collected native task
            {detail.collected_at
              ? ` · saved ${new Date(detail.collected_at).toLocaleString()}`
              : ""}
            . Live controls are unavailable.
          </p>
        ) : null}
        {job.error ? (
          <p role="alert" className="text-sm text-danger">
            {job.error}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        {detailError ? (
          <p role="alert" className="text-sm text-danger">
            Native task unavailable: {detailError}
          </p>
        ) : null}
      </div>
      <Conversation
        threadKey={`cloud:${job.id}`}
        items={detail?.items ?? []}
        isLoading={Boolean(job.worker) && !detail && !detailError}
        isThinking={detail?.is_live && job.status === "running"}
        isWaitingForInput={
          detail?.is_live &&
          (pending.length > 0 || job.status === "awaiting_input")
        }
        exportTitle={detail?.thread.title ?? job.prompt}
        emptyState={
          <div className="p-6 text-sm text-fg-muted">
            {job.status === "provisioning"
              ? "Starting the sandbox and native Codex task…"
              : "No native messages available."}
          </div>
        }
      />
      <InteractiveRequestBar
        requests={pending}
        onRespond={async (request, response) => {
          await api.respond(job.id, request.request_id, response);
          await refresh(true);
        }}
      />
      <form
        className="flex shrink-0 items-end gap-2 border-t border-border-subtle px-6 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!followup.trim() || !canContinue || busy) return;
          void action("turn", () => api.sendTurn(job.id, followup.trim())).then(
            (sent) => {
              if (sent) setFollowup("");
            },
          );
        }}
      >
        <Field
          label="Follow-up instructions"
          htmlFor="cloud-followup"
          className="flex-1"
        >
          <Textarea
            id="cloud-followup"
            rows={2}
            value={followup}
            disabled={!canContinue || Boolean(busy)}
            onChange={(event) => setFollowup(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          disabled={!canContinue || !followup.trim() || Boolean(busy)}
        >
          {busy === "turn" ? "Sending…" : "Send"}
        </Button>
      </form>
    </div>
  );
}
