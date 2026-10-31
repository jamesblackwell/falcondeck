import { useEffect, useRef, useState } from "react";
import type { CloudJob, ThreadSummary } from "@falcondeck/client-core";
import { Button } from "@falcondeck/ui";
import type { CloudApi } from "./cloud-api";

const labels: Record<string, string> = {
  provisioning: "Preparing cloud environment…",
  running: "Running in the cloud",
  awaiting_input: "Cloud environment ready",
  completed: "Cloud work complete",
  stopped: "Cloud paused · send a message to continue",
  stopping: "Saving and stopping cloud environment…",
  failed: "Cloud environment needs attention",
  expired: "Cloud environment expired",
  unknown: "Cloud state needs checking",
};

/** Environment details belong to the open conversation, not a separate task list. */
export function CloudConversationStatus({ thread, api, onChanged }: {
  thread: ThreadSummary;
  api: CloudApi | null;
  onChanged: () => void;
}) {
  const jobId = thread.cloud?.job_id;
  const [job, setJob] = useState<CloudJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setJob(null);
    setError(null);
    setBusy(false);
    setConfirmImport(false);
    if (!api || !jobId) return;
    void api.job(jobId).then((next) => {
      if (generation.current === current) setJob(next);
    }).catch((reason: unknown) => {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : "Cloud details are unavailable.");
    });
    return () => { generation.current += 1; };
  }, [api, jobId, thread.cloud?.status, thread.cloud?.has_result]);

  if (!thread.cloud || !jobId) return null;
  const result = job?.result;
  async function operate(action: "collect" | "stop" | "importResult") {
    if (!api || !jobId || busy) return;
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api[action](jobId);
      if (generation.current !== current) return;
      setJob(next);
      setConfirmImport(false);
      onChanged();
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : "The cloud action failed.");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <details className="border-b border-border-subtle px-5 py-2 text-xs text-fg-secondary">
      <summary className="fd-focus cursor-pointer">{labels[thread.cloud.status] ?? "Cloud environment"}</summary>
      <div className="mt-3 space-y-3 pb-1">
        {thread.cloud.error ? <p role="alert" className="text-danger">{thread.cloud.error}</p> : null}
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
        <p>Your changes stay in this cloud environment until you import them. The original project is separate.</p>
        {job ? <p>{job.source.included_paths.length} source files · {job.source.excluded_paths.length} excluded</p> : null}
        {job?.source.excluded_paths.length ? <details><summary className="fd-focus cursor-pointer">Excluded files</summary><ul className="mt-2 max-h-36 overflow-auto font-mono">{job.source.excluded_paths.map((path) => <li key={path}>{path}</li>)}</ul></details> : null}
        {result ? <p>{result.changed_paths.length} changed · {result.deleted_paths.length} deleted{result.imported_at ? " · Imported" : ""}</p> : null}
        {confirmImport ? <div className="space-y-2"><p>Apply the cloud changes to the source project? Conflicting local edits will block import.</p><Button size="sm" disabled={busy} onClick={() => void operate("importResult")}>Apply to project</Button> <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmImport(false)}>Cancel</Button></div> : <div className="flex flex-wrap gap-2">
          {result && !result.imported_at ? <Button size="sm" disabled={!api || busy} onClick={() => setConfirmImport(true)}>Import changes…</Button> : null}
          {!result && thread.cloud.has_result ? <span>Loading saved changes…</span> : null}
          {["running", "awaiting_input"].includes(thread.cloud.status) ? <><Button size="sm" variant="secondary" disabled={!api || busy} onClick={() => void operate("collect")}>Collect changes</Button><Button size="sm" variant="ghost" disabled={!api || busy} onClick={() => void operate("stop")}>Pause cloud</Button></> : null}
        </div>}
      </div>
    </details>
  );
}
