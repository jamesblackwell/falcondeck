/* Standalone analytics fixture: `npm run dev` → /analytics-qa.html.
   Renders the Settings → Analytics panel against a stubbed daemon with a full
   period of invented data, so tab layouts, bounded tables and filters can be
   checked without live analytics. `?tab=<AnalyticsTab>` picks the tab,
   `?theme=light|dark` the mode, `?state=loading|empty` the first-run states,
   `?state=prefix` adds a proven prefix change, which real records lack so far.
   The cache report is real-shaped: real figures, names replaced. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type { AnalyticsCacheReport, AnalyticsStatus, AnalyticsSummary, AnalyticsUsageReport } from "@falcondeck/client-core";
import { ToastProvider, initAppearance, updateAppearance } from "@falcondeck/ui";

import { AnalyticsPanel } from "./components/settings/AnalyticsPanel";
import { ANALYTICS_TABS } from "./components/settings/analytics/analytics-utils";

import cacheReport from "./analytics-qa-cache.json";

import "./index.css";

initAppearance();
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") updateAppearance({ theme });
const fixtureState = params.get("state");
const tab = ANALYTICS_TABS.find((option) => option.value === params.get("tab"));

const AGENTS = [
  { provider: "claude", model: "claude-opus-5-5" },
  { provider: "claude", model: "claude-sonnet-5-5" },
  { provider: "claude", model: "claude-haiku-5-5" },
  { provider: "codex", model: "gpt-6.1-sol" },
  { provider: "grok", model: "grok-4.7-build" },
];
const BOTS = ["Juno - CPO", "Iris - CMO", "Atlas - CTO", null];
const FLAGS = [["rarely_useful"], [], ["failing"], ["very_frequent", "thread_per_run"], [], ["large_reused_context"]];
const TASKS = ["Inbox sweep", "Nightly repo check", "Fast start monitor", "Sentry triage", "Weekly digest", "Dependency audit", "Deploy watch", "Review queue"];

const totals = (seed: number) => ({
  input_tokens: 40_000 * seed,
  cache_read_tokens: 26_000_000 * seed,
  cache_write_tokens: 1_900_000 * seed,
  output_tokens: 180_000 * seed,
  turns: 12 * seed,
  cost_usd: 3.4 * seed,
});

const usage = BOTS.flatMap((bot, botIndex) =>
  AGENTS.map((agent, agentIndex) => ({
    bot,
    ...agent,
    totals: totals(1 + (7 - botIndex * 2) * (5 - agentIndex)),
    cost_sources: agent.provider === "grok" ? ["provider_unverified"] : ["provider"],
  })),
).sort((a, b) => b.totals.cache_read_tokens - a.totals.cache_read_tokens);

const usageTotals = usage.reduce((sum, row) => {
  for (const key of Object.keys(sum) as Array<keyof typeof sum>) sum[key] += row.totals[key];
  return sum;
}, totals(0));

const threads: AnalyticsUsageReport = {
  days: 30,
  group: "thread",
  totals: usageTotals,
  rows: Array.from({ length: 64 }, (_, index) => {
    const agent = AGENTS[index % AGENTS.length];
    const automation = index % 3 === 0 ? TASKS[index % TASKS.length] : null;
    return {
      key: `thread-${index}`,
      label: index % 7 === 0 ? "Investigate the relay reconnect flap on spotty mobile networks and write up the findings" : `Task ${index + 1}`,
      totals: totals(90 - index),
      cost_sources: ["provider"],
      thread: {
        bot: BOTS[index % BOTS.length],
        workspace: "ws-1",
        project: index % 2 ? "falcondeck" : "quizgecko",
        origin: automation ? "automation" : index % 3 === 1 ? "agent_spawn" : "user",
        automation,
        ...agent,
        avg_context_per_call: 84_000 - index * 700,
      },
    };
  }),
};

const summary: AnalyticsSummary = {
  days: 30,
  generated_at: "2026-11-04T12:00:00Z",
  totals: { user_messages: 1204, scheduled_messages: 392, agent_messages: 4120, ack_like_messages: 610, delegations: 188, turns: 6230, failed_turns: 41, file_writes: 9120, commits: 312 },
  daily: Array.from({ length: 30 }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
    user_messages: 20 + ((index * 37) % 60),
    agent_messages: 90 + ((index * 53) % 120),
    turns: 140 + ((index * 71) % 150),
    commits: (index * 13) % 22,
    scheduled: 8 + ((index * 17) % 20),
  })),
  agent_pairs: Array.from({ length: 12 }, (_, index) => ({ from: `a${index}`, from_title: "Juno - CPO", to: `b${index}`, to_title: `Task ${index + 1}`, messages: 90 - index * 6, avg_chars: 420 - index * 12, ack_like: index * 2 })),
  recent_agent_messages: Array.from({ length: 12 }, (_, index) => ({ at: `2026-11-04T1${index % 10}:00:00Z`, from_title: "Juno - CPO", to_title: "Iris - CMO", chars: 40, ack_like: index % 3 === 0, excerpt: index % 3 === 0 ? "Thanks, got it." : "The relay fix is on main; next up is the reconnect telemetry." })),
  files: Array.from({ length: 25 }, (_, index) => ({ path: `/Users/me/www/sites/falcondeck/crates/falcondeck-daemon/src/app/module_${index}.rs`, writes: 200 - index * 7, threads: 12 - (index % 9), contested_days: index % 4 })),
  bots: BOTS.filter((bot) => bot).map((bot, index) => ({ name: bot!, turns: 2400 - index * 400, avg_turn_ms: 192_000 + index * 40_000, avg_context_tokens: 12_400, delegations: 90 - index * 20, messages_sent: 800 - index * 150, commits: 120 - index * 30 })),
  providers: [
    { provider: "claude", turns: 4100, failed: 21, avg_turn_ms: 201_000, input_tokens: 2_400_000_000, output_tokens: 14_000_000, avg_peak_context_tokens: 148_000 },
    { provider: "codex", turns: 1800, failed: 19, avg_turn_ms: 3_900_000, input_tokens: 840_000_000, output_tokens: 6_100_000, avg_peak_context_tokens: 212_000 },
    { provider: "grok", turns: 330, failed: 1, avg_turn_ms: 95_000, input_tokens: 52_000_000, output_tokens: 410_000, avg_peak_context_tokens: 61_000 },
  ],
  projects: ["falcondeck", "quizgecko", "lucidpic", "miner", "Juno - CPO"].map((project, index) => ({ project, messages: 600 - index * 110, avg_chars: 310, commits: 180 - index * 40 })),
  triggers: { user: 1204, scheduled: 2392, agent: 1422, delegation: 188, other: 1024 },
  waiting: { requests: 310, median_request_wait_ms: 94_000, replies: 980, median_reply_ms: 642_000, p90_reply_ms: 16_200_000 },
  automations: Array.from({ length: 34 }, (_, index) => {
    const agent = AGENTS[index % AGENTS.length];
    const idle = index % 9 === 8;
    return {
      id: `automation-${index}`,
      name: `${TASKS[index % TASKS.length]}${index >= TASKS.length ? ` ${index}` : ""}`,
      state: index % 6 === 5 ? "paused" : "enabled",
      schedule: index % 2 ? "Every 30 minutes" : "Daily at 09:00",
      thread_mode: "new_each_run",
      runs: idle ? 0 : 1440 - index * 40,
      no_action: idle ? 0 : 1100 - index * 30,
      failed: index % 6 === 2 ? 90 : 0,
      skipped: 0,
      threads: idle ? 0 : 60 - index,
      agent_ms: idle ? 0 : 41_000_000 - index * 900_000,
      last_run_at: idle ? null : "2026-11-04T09:00:00Z",
      flags: FLAGS[index % FLAGS.length],
      models: idle ? [] : [agent.model],
      agents: idle ? [] : index % 4 === 0 ? [agent, AGENTS[(index + 1) % AGENTS.length]] : [agent],
      bots: BOTS[index % BOTS.length] ? [BOTS[index % BOTS.length]!] : [],
      provider: agent.provider,
      configured_model: index % 5 === 0 ? "claude-opus-5-5" : null,
      usage: totals(idle ? 0 : 60 - index),
    };
  }),
  usage,
};

const emptySummary: AnalyticsSummary = {
  ...summary,
  totals: { user_messages: 0, scheduled_messages: 0, agent_messages: 0, ack_like_messages: 0, delegations: 0, turns: 0, failed_turns: 0, file_writes: 0 },
  daily: [],
  agent_pairs: [],
  recent_agent_messages: [],
  files: [],
  bots: [],
  providers: [],
  projects: [],
  triggers: undefined,
  waiting: undefined,
  automations: [],
  usage: [],
};

const status: AnalyticsStatus = {
  settings: { enabled: true, record_prompts: true, record_usage: true, retention_months: 12 },
  folder: "/Users/me/.falcondeck/analytics",
  events_bytes: 8_400_000,
  prompts_bytes: 2_100_000,
  usage_bytes: 640_000,
  usage_health: [{ provider: "claude", completed_turns: 840, usage_records_written: 1120, turns_with_usage: 838, missing_usage_turns: 2 }],
};

const empty = fixtureState === "empty";
const prompts = Array.from({ length: empty ? 0 : 40 }, (_, index) => ({
  at: `2026-11-04T0${index % 10}:12:00Z`,
  project: "falcondeck",
  thread_id: `thread-${index}`,
  title: "Tidy the analytics panel",
  provider: "claude",
  text: "Make the analytics panel tidy and usable, with tabs and bounded tables.",
}));

const cache: AnalyticsCacheReport =
  fixtureState === "prefix"
    ? {
        ...cacheReport,
        rules: cacheReport.rules.map((rule) =>
          rule.id === "prefix_change"
            ? { ...rule, flagged: 1, estimated_usd: 3.3 }
            : rule,
        ),
        waste: [
          {
            rule: "prefix_change",
            group: "cache",
            severity: "high",
            certainty: "proven",
            label: "Juno - CPO",
            reason:
              "First call missed a warm cache 2 times: same main model and effort, no compaction recorded, 412k rewritten. The records don't show what changed",
            estimated_usd: 3.3,
            occurrences: 2,
            thread: "thread-home",
            workspace: "workspace-1",
          },
          ...cacheReport.waste,
        ],
      }
    : cacheReport;

window.fetch = async (input) => {
  const url = String(input);
  if (fixtureState === "loading") await new Promise(() => {});
  const body = url.includes("/cache")
    ? empty ? { days: 30 } : cache
    : url.includes("/summary")
    ? empty ? emptySummary : summary
    : url.includes("/usage")
      ? empty ? { ...threads, totals: totals(0), rows: [] } : threads
      : url.includes("/prompts")
        ? prompts
        : status;
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <div className="h-screen overflow-y-auto bg-surface-1 px-8 py-10 text-fg-primary">
        <div className="mx-auto w-full max-w-4xl">
          <AnalyticsPanel
            baseUrl="http://analytics-qa"
            onToast={() => {}}
            onOpenAutomation={() => {}}
            onOpenThread={() => {}}
            focusRequest={tab ? { setting: tab.label } : null}
          />
        </div>
      </div>
    </ToastProvider>
  </StrictMode>,
);
