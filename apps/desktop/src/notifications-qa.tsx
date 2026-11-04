/* Standalone Notifications fixture: `npm run dev` → /notifications-qa.html.
   Renders the real sidebar entry, centre and report against a fake daemon, so
   layout can be screenshot without a daemon or the app.
   ?theme=light|dark, ?filter=needs_you|bots, ?report=N-9 (open that report),
   ?empty=1 (no records). */
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  NotificationCounts,
  NotificationListQuery,
  NotificationRecord,
} from "@falcondeck/client-core";
import { ToastProvider, TooltipProvider, initAppearance, updateAppearance } from "@falcondeck/ui";

import { NotificationsView } from "./components/NotificationsView";
import { DesktopSidebar } from "./components/Sidebar";
import { useNotificationCentre, type NotificationCentreApi } from "./hooks/useNotificationCentre";
import "./index.css";

initAppearance();
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") updateAppearance({ theme });

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const REPORT = `# Nightly backup check

All **14 archives** verified. Nothing needs you.

| Target | Size | Age |
| --- | --- | --- |
| iCloud | 2.1 GB | 6 h |
| Offsite | 2.1 GB | 6 h |

- Secrets stayed excluded
- Oldest archive pruned at 30 days

\`\`\`sh
falcondeck backup verify --all
\`\`\`
`;

const base = {
  importance: "normal",
  has_body: false,
  repeat_count: 0,
  workspace_id: "workspace-1",
  thread_id: "thread-1",
} as const;

const SEED: NotificationRecord[] = [
  { ...base, id: "N-9", seq: 9, kind: "agent_notice", title: "Nightly backup check", preview: "All 14 archives verified. Nothing needs you.", created_at: ago(12), bot: "Juno", has_body: true },
  { ...base, id: "N-8", seq: 8, kind: "review", title: "Approve the pricing page", preview: "Two variants, one recommendation.", created_at: ago(38), bot: "Juno", target: { type: "review", review_id: "R-12" } },
  { ...base, id: "N-7", seq: 7, kind: "input_required", title: "Fix the relay reconnect", preview: "Run the migration on staging?", created_at: ago(95), target: { type: "thread", workspace_id: "workspace-1", thread_id: "thread-1" } },
  { ...base, id: "N-6", seq: 6, kind: "error", title: "Mobile build", preview: "The provider stopped: credit balance too low.", created_at: ago(180), target: { type: "thread", workspace_id: "workspace-1", thread_id: "thread-1" } },
  { ...base, id: "N-5", seq: 5, kind: "turn_complete", title: "Update the docs", preview: "Docs updated and committed.", created_at: ago(26 * 60), read_at: ago(25 * 60), target: { type: "thread", workspace_id: "workspace-1", thread_id: "thread-1" } },
  { ...base, id: "N-4", seq: 4, kind: "agent_notice", title: "Shipped the sync fix", preview: "Three clients verified on the real relay.", created_at: ago(27 * 60), read_at: ago(25 * 60), bot: "Mara", importance: "high" },
  { ...base, id: "N-3", seq: 3, kind: "review", title: "Logo direction", preview: "Accepted.", created_at: ago(29 * 60), read_at: ago(25 * 60), resolved_at: ago(26 * 60), bot: "Juno", target: { type: "review", review_id: "R-9" } },
  { ...base, id: "N-2", seq: 2, kind: "turn_complete", title: "Sidebar refactor", preview: "Finished. 42 tests pass.", created_at: ago(4 * 1440), read_at: ago(3 * 1440), target: { type: "thread", workspace_id: "workspace-1", thread_id: "thread-1" } },
];

function needsYou(record: NotificationRecord) {
  return (record.kind === "review" || record.kind === "input_required") && !record.resolved_at;
}

function fakeApi(): NotificationCentreApi {
  let rows = params.get("empty") ? [] : SEED;
  const counts = (): NotificationCounts => ({
    unread_count: rows.filter((row) => !row.read_at).length,
    needs_you_count: rows.filter(needsYou).length,
    latest_seq: rows[0]?.seq ?? 0,
  });
  return {
    listNotifications: async (query: NotificationListQuery = {}) => ({
      ...counts(),
      items: rows.filter((row) => {
        if (query.filter === "needs_you") return needsYou(row);
        if (query.filter === "bots") return row.kind === "agent_notice" || Boolean(row.bot);
        return true;
      }),
    }),
    getNotification: async (id) => {
      const row = rows.find((candidate) => candidate.id === id)!;
      return row.has_body ? { ...row, body: REPORT } : row;
    },
    markNotificationsRead: async ({ ids, up_to_seq }) => {
      rows = rows.map((row) =>
        ids?.includes(row.id) || row.seq <= (up_to_seq ?? -1) ? { ...row, read_at: new Date().toISOString() } : row,
      );
      return counts();
    },
  };
}

function Fixture() {
  const api = useMemo(() => fakeApi(), []);
  const [open, setOpen] = useState(true);
  const centre = useNotificationCentre({ api, baseUrl: null, enabled: true });
  const filter = params.get("filter");
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current) return;
    applied.current = true;
    if (filter === "needs_you" || filter === "bots") centre.setFilter(filter);
  }, [centre, filter]);
  const report = params.get("report");
  return (
    <div className="flex h-screen bg-surface-0 p-2 gap-2">
      <div className="flex w-[260px] shrink-0 flex-col overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1">
        <DesktopSidebar
          groups={[]}
          selectedWorkspaceId={null}
          selectedThreadId={null}
          onSelectWorkspace={() => {}}
          onSelectThread={() => {}}
          onRenameThread={async () => {}}
          onArchiveThread={async () => {}}
          onDeleteThread={async () => {}}
          onOpenTickets={() => setOpen(false)}
          onOpenNotifications={() => setOpen(true)}
          notificationsOpen={open}
          unreadNotifications={centre.counts.unread_count}
          onOpenReviews={() => {}}
          reviewCount={1}
          onOpenScheduled={() => {}}
          onOpenExtensions={() => {}}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle">
        <NotificationsView
          centre={centre}
          api={api}
          openRequest={report ? { id: report, key: 1 } : null}
          onOpenThread={() => {}}
          onOpenReview={() => {}}
          onPreview={() => {}}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <TooltipProvider>
        <Fixture />
      </TooltipProvider>
    </ToastProvider>
  </StrictMode>,
);
