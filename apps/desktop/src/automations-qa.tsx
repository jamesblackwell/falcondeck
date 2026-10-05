/* Dev-only fixture: /automations-qa.html?theme=light|dark.
   All CRUD operations use in-memory records; no agent work is dispatched. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Automation, AutomationRun, DaemonSnapshot, WorkspaceSummary } from "@falcondeck/client-core";
import { initAppearance, ToastProvider, useToast } from "@falcondeck/ui";
import type { HostManager, HostScopedApi, HostView } from "./hosts";
import { ScheduledTasksView } from "./components/ScheduledTasksView";
import "./index.css";

const now = Date.now();
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const workspaces = ["quizgecko", "lucidpic", "falcondeck"].map((name) => ({
  id: `workspace-${name}`, path: `/Users/james/www/sites/${name}`, status: "ready",
  agents: [{ provider: "codex", label: "Codex", models: [] }], default_provider: "codex",
  skills: [], models: [], collaboration_modes: [],
})) as unknown as WorkspaceSummary[];

function automation(name: string, project: string, minutes: number, patch: Partial<Automation> = {}): Automation {
  return {
    id: `automation-${name.toLowerCase().replaceAll(/\W+/g, "-")}`, revision: 1, name,
    description: `Check ${project} and report anything that needs attention.`, state: "enabled",
    trigger: { kind: "cron", expression: "0 9 * * *", timezone: "Europe/London" },
    task: { kind: "prompt", instruction: `Check ${project} and report anything that needs attention.` },
    target: { workspace_path: `/Users/james/www/sites/${project}`, provider: "codex", thread: { kind: "new_each_run" }, selected_skills: [] },
    concurrency_policy: "queue_one", misfire_policy: "skip", elevated: false, required_connectors: [],
    next_run_at: at(minutes), created_at: at(-1440), updated_at: at(-60), ...patch,
  };
}

let records: Automation[] = [
  automation("Check PRs Targeting Branch", "quizgecko", 4300, { trigger: { kind: "cron", expression: "20 2 * * MON,THU", timezone: "UTC" } }),
  automation("Check Sentry Issues", "quizgecko", 360),
  automation("Check Sentry patch after daytime traffic", "lucidpic", 45, { trigger: { kind: "once", run_at: at(45) } }),
  automation("Feedback deployment traffic check", "lucidpic", 900, { trigger: { kind: "once", run_at: at(900) } }),
  automation("Infra Check", "quizgecko", 1500),
  automation("Investigate recent Lucidpic feedback", "lucidpic", 15, { latest_outcome: { status: "failed", finished_at: at(-20), preview: "The previous check could not reach the deployment." } }),
  automation("Morning GitHub Bug Fixer", "quizgecko", 1300),
  automation("Native Support Ticket Sweep", "quizgecko", 80),
  automation("Nightly Memory Maintainer", "quizgecko", 1140),
  automation("FalconDeck release check", "falcondeck", 120, { latest_outcome: { status: "running", finished_at: at(-5) } }),
  automation("Weekly billing audit", "quizgecko", 0, { state: "paused", next_run_at: null }),
  automation("Lucidpic Bug Scan", "lucidpic", 0, { state: "paused", next_run_at: null }),
  automation("Review September migration", "falcondeck", 0, { state: "completed", next_run_at: null }),
];

const snapshot = {
  daemon: { version: "qa", started_at: at(-120), capabilities: { scheduled_tasks: true } },
  workspaces, threads: [], interactive_requests: [], preferences: {},
  extensions: { catalog: [], views: [] }, scheduled_tasks: [],
} as unknown as DaemonSnapshot;
const hosts = [{
  id: "host-qa-offline", name: "Build server", status: "disconnected", presence: null,
  snapshot: null, enabled: true, paired: true, needsRepair: false, lastError: null,
  sshTarget: null, sshPort: null, relayUrl: "wss://connect.falcondeck.com",
}] as HostView[];
const manager = { connection: () => null } as unknown as HostManager;

const api: HostScopedApi = {
  scheduledTasks: async () => [],
  scheduledTask: async () => { throw new Error("No legacy fixture tasks"); },
  scheduledTaskRuns: async () => [],
  createScheduledTask: async () => { throw new Error("Use canonical automation creation"); },
  updateScheduledTask: async () => { throw new Error("No legacy fixture tasks"); },
  deleteScheduledTask: async () => ({ ok: true }),
  runScheduledTask: async () => { throw new Error("No legacy fixture tasks"); },
  controlGet: async (request) => {
    const record = records.find((item) => item.id === request.id);
    let data: unknown = {};
    if (request.resource === "automations") data = [...records];
    if (request.resource === "automation") data = record;
    if (request.resource === "agent_control.settings") data = { providers: { codex: { enabled: true } }, allow_elevated_automations: false };
    if (request.resource === "automation.runs") data = record?.latest_outcome ? [{
      id: `run-${record.id}`, automation_id: record.id, automation_name: record.name,
      automation_revision: record.revision, status: record.latest_outcome.status,
      trigger: "scheduled", queued_at: record.latest_outcome.finished_at,
      outcome_preview: record.latest_outcome.preview,
    } satisfies AutomationRun] : [];
    return { resource: request.resource, data };
  },
  controlExecute: async (request) => {
    const id = request.arguments.automation_id as string;
    const current = records.find((item) => item.id === id);
    if (request.operation === "automation.create") {
      const args = request.arguments as unknown as Automation;
      const created = { ...automation(args.name, "falcondeck", 60), ...args, id: `qa-${Date.now()}` };
      records = [...records, created];
      return { ok: true, operation: request.operation, data: created };
    }
    if (!current) throw new Error("Automation no longer exists");
    if (request.expected_revision !== undefined && request.expected_revision !== current.revision) {
      throw new Error("Automation changed since it was loaded");
    }
    if (request.operation === "automation.delete") records = records.filter((item) => item.id !== id);
    else {
      let patch: Partial<Automation> = { updated_at: new Date().toISOString(), revision: current.revision + 1 };
      if (request.operation === "automation.update") patch = { ...patch, ...request.arguments as Partial<Automation> };
      if (request.operation === "automation.pause") patch = { ...patch, state: "paused", next_run_at: null };
      if (request.operation === "automation.resume") patch = { ...patch, state: "enabled", next_run_at: at(60) };
      if (request.operation === "automation.run_now") patch.latest_outcome = { status: "queued", finished_at: new Date().toISOString() };
      records = records.map((item) => item.id === id ? { ...item, ...patch } : item);
    }
    return { ok: true, operation: request.operation, data: records.find((item) => item.id === id) };
  },
};
const refresh = async () => {};

function Fixture() {
  const { toast } = useToast();
  return <div className="h-screen w-screen">
    <ScheduledTasksView
      localSnapshot={snapshot} localApi={api} localBaseUrl={null}
      hosts={hosts} manager={manager} onRefreshLocal={refresh} onToast={toast}
      onCreateWithAgent={() => toast({ variant: "default", title: "Create with agent", description: "This fixture keeps all changes in memory." })}
      onOpenThread={() => {}}
    />
  </div>;
}

initAppearance();
const theme = new URLSearchParams(window.location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
const palette = new URLSearchParams(window.location.search).get("palette");
if (palette) document.documentElement.dataset.palette = palette;
createRoot(document.getElementById("root")!).render(<StrictMode><ToastProvider><Fixture /></ToastProvider></StrictMode>);
