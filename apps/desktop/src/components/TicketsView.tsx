import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  TICKET_PRIORITIES, TICKET_STATES,
  type CreateTicketArgs, type DaemonApiClient, type Ticket, type TicketState, type UpdateTicketArgs,
} from "@falcondeck/client-core";
import { MessageMarkdown } from "@falcondeck/chat-ui";
import {
  Badge, Button, Card, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  SettingsPageHeader, Textarea,
} from "@falcondeck/ui";
import { Plus, RefreshCw, X } from "lucide-react";
import { useControlStateEvents } from "../hooks/useControlStateEvents";

export const TICKET_STATE_LABELS: Record<TicketState, string> = {
  backlog: "Backlog", active: "Active", blocked: "Blocked", waiting_on_james: "Waiting on James", done: "Done", dropped: "Dropped",
};
type TicketApi = Pick<DaemonApiClient, "listTickets" | "createTicket" | "updateTicket" | "commentTicket">;
type Props = {
  api: TicketApi | null;
  baseUrl: string | null;
  owners?: string[];
  projects?: string[];
  threads?: { id: string; title: string | null }[];
  onOpenThread: (id: string) => void;
};
const closed = (state: TicketState) => state === "done" || state === "dropped";
export function ticketAge(createdAt: string): string {
  const hours = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 3_600_000));
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
function TicketSelect({ label, value, options, onChange, disabled }: {
  label: string; value: string; options: readonly { value: string; label: string }[];
  onChange: (value: string) => void; disabled?: boolean;
}) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}
const priorityOptions = TICKET_PRIORITIES.map((value) => ({ value, label: value }));
const stateOptions = TICKET_STATES.map((value) => ({ value, label: TICKET_STATE_LABELS[value] }));
const unique = (values: string[]) => [...new Set(values)].sort();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Ticket request failed.";

export function TicketsView({ api, baseUrl, owners = [], projects = [], threads = [], onOpenThread }: Props) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parent_id?: string } | null>(null);
  const [owner, setOwner] = useState("all");
  const [project, setProject] = useState("all");
  const [priority, setPriority] = useState("all");
  const [showClosed, setShowClosed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Each connection owns its async work. Cleanup invalidates callbacks before
  // another daemon can reuse the same human-friendly ticket IDs.
  const connection = useMemo(() => ({ active: false }), [api, baseUrl]);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!connection.active) return;
    if (!api) { setLoading(false); return; }
    const current = ++request.current;
    try {
      const rows = await api.listTickets({ include_closed: true });
      if (connection.active && request.current === current) { setTickets(rows); setError(null); }
    } catch (error) { if (connection.active && request.current === current) setError(errorMessage(error)); }
    finally { if (connection.active && request.current === current) setLoading(false); }
  }, [api, connection]);
  useLayoutEffect(() => {
    connection.active = true;
    setTickets([]); setSelectedId(null); setCreating(null); setLoading(true);
    void refresh();
    return () => { connection.active = false; request.current++; };
  }, [refresh, connection]);
  useControlStateEvents(baseUrl, (_revision, domains) => {
    if (domains.includes("tickets")) void refresh();
  });
  const ownerChoices = unique(["James", ...owners, ...tickets.flatMap((ticket) => ticket.owner ? [ticket.owner] : [])]);
  const projectChoices = unique([...projects, ...tickets.flatMap((ticket) => ticket.project ? [ticket.project] : [])]);
  const visible = useMemo(() => tickets.filter((ticket) =>
    (showClosed || !closed(ticket.state)) &&
    (owner === "all" || (ticket.owner ?? "") === (owner === "unassigned" ? "" : owner)) &&
    (project === "all" || (ticket.project ?? "") === (project === "none" ? "" : project)) &&
    (priority === "all" || ticket.priority === priority)
  ).sort((a, b) => a.priority.localeCompare(b.priority) || a.created_at.localeCompare(b.created_at)), [tickets, showClosed, owner, project, priority]);
  const selected = tickets.find((ticket) => ticket.id === selectedId);
  const accept = (ticket: Ticket) => {
    if (!connection.active) return false;
    setTickets((rows) => [...rows.filter((row) => row.id !== ticket.id), ticket]);
    // Invalidate an older in-flight read, then reconcile with the daemon.
    request.current++;
    void refresh();
    return true;
  };
  return <div className="flex h-full min-h-0 flex-col bg-surface-1 p-5">
    <SettingsPageHeader title="Tickets" description="A shared board you and the bots can see. Agents can create up to five tickets a day each."
      actions={<><Button variant="ghost" size="sm" onClick={() => void refresh()} aria-label="Refresh tickets"><RefreshCw className="h-4 w-4" /></Button>
        <Button size="sm" disabled={!api} onClick={() => setCreating({})}><Plus className="h-4 w-4" />New ticket</Button></>} />
    <div className="flex flex-wrap items-center gap-2 py-4" aria-label="Ticket filters">
      <TicketSelect label="Filter owner" value={owner} onChange={setOwner} options={[{ value: "all", label: "All owners" }, { value: "unassigned", label: "Unassigned" }, ...ownerChoices.map((value) => ({ value, label: value }))]} />
      <TicketSelect label="Filter project" value={project} onChange={setProject} options={[{ value: "all", label: "All projects" }, { value: "none", label: "No project" }, ...projectChoices.map((value) => ({ value, label: value }))]} />
      <TicketSelect label="Filter priority" value={priority} onChange={setPriority} options={[{ value: "all", label: "All priorities" }, ...priorityOptions]} />
      <label className="ml-2 flex items-center gap-2 text-xs text-fg-secondary"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />Show done / dropped</label>
    </div>
    {error && <p role="alert" className="pb-3 text-sm text-danger">{error}</p>}
    {!api && <p role="status">Connect to the daemon to use Tickets.</p>}
    {loading && <p role="status">Loading tickets…</p>}
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      <div className="flex min-w-0 flex-1 gap-3 overflow-auto pb-3" aria-label="Tickets board">
        {TICKET_STATES.filter((state) => showClosed || !closed(state)).map((state) => {
          const rows = visible.filter((ticket) => ticket.state === state);
          return <section key={state} aria-label={TICKET_STATE_LABELS[state]} className="w-64 min-w-56 flex-1">
            <h2 className="mb-3 flex items-center justify-between text-xs font-medium text-fg-secondary">{TICKET_STATE_LABELS[state]}<span className="text-fg-muted">{rows.length}</span></h2>
            <div className="space-y-2">{rows.map((ticket) => <Card key={ticket.id} className={selectedId === ticket.id ? "border-accent" : ""}>
              <button type="button" className="fd-focus w-full rounded-[inherit] p-3 text-left" onClick={() => { setSelectedId(ticket.id); setCreating(null); }} aria-label={`${ticket.id} ${ticket.title}`}>
                <div className="mb-2 flex items-center justify-between text-xs text-fg-muted"><span>{ticket.id}{ticket.parent_id ? ` · ${ticket.parent_id}` : ""}</span><Badge>{ticket.priority}</Badge></div>
                <p className="mb-3 text-sm font-medium text-fg-primary">{ticket.title}</p>
                <div className="flex items-center justify-between gap-2 text-xs text-fg-muted"><span>{ticket.owner ?? "Unassigned"}</span><span>{ticketAge(ticket.created_at)} old</span></div>
                <div className="mt-2 flex gap-3 text-xs text-fg-muted"><span>{tickets.filter((row) => row.parent_id === ticket.id).length} sub-tickets</span><span>{ticket.comments.length} comments</span></div>
              </button>
            </Card>)}
            {!loading && rows.length === 0 && <p className="rounded-[var(--fd-radius-md)] border border-dashed border-border-subtle p-4 text-xs text-fg-muted">No tickets</p>}</div>
          </section>;
        })}
      </div>
      {(creating || selected) && api && <aside aria-label="Ticket detail" className="w-[26rem] max-w-[50%] shrink-0 overflow-y-auto border-l border-border-subtle pl-4">
        <div className="mb-3 flex justify-end"><Button size="sm" variant="ghost" aria-label="Close ticket detail" onClick={() => { setCreating(null); setSelectedId(null); }}><X className="h-4 w-4" /></Button></div>
        {creating ? <NewTicket key={creating.parent_id ?? "new"} api={api} parentId={creating.parent_id} owners={ownerChoices} projects={projectChoices} onCreated={(ticket) => { if (accept(ticket)) { setCreating(null); setSelectedId(ticket.id); } }} /> : selected &&
          <TicketDetail key={selected.id} ticket={selected} tickets={tickets} api={api} owners={ownerChoices} projects={projectChoices} threads={threads} onSaved={accept} onSelect={setSelectedId} onAddChild={() => setCreating({ parent_id: selected.id })} onOpenThread={onOpenThread} />}
      </aside>}
    </div>
  </div>;
}

function ChoiceLists({ owners, projects }: { owners: string[]; projects: string[] }) {
  return <><datalist id="ticket-owners">{owners.map((value) => <option key={value} value={value} />)}</datalist><datalist id="ticket-projects">{projects.map((value) => <option key={value} value={value} />)}</datalist></>;
}
function NewTicket({ api, parentId, owners, projects, onCreated }: {
  api: TicketApi; parentId?: string; owners: string[]; projects: string[]; onCreated: (ticket: Ticket) => void;
}) {
  const [draft, setDraft] = useState<CreateTicketArgs>({ title: "", description: "", owner: "", project: "", priority: "P2", parent_id: parentId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form className="space-y-4" onSubmit={(event) => {
    event.preventDefault(); setBusy(true); setError(null);
    void api.createTicket(draft).then(onCreated).catch((error) => setError(errorMessage(error))).finally(() => setBusy(false));
  }}>
    <fieldset disabled={busy} className="contents">
    <h2 className="text-base font-semibold">{parentId ? `Sub-ticket of ${parentId}` : "New ticket"}</h2>
    <ChoiceLists owners={owners} projects={projects} />
    <label className="block space-y-1 text-xs">Title<Input required maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
    <label className="block space-y-1 text-xs">Description (Markdown)<Textarea rows={5} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
    <label className="block space-y-1 text-xs">Owner<Input list="ticket-owners" value={draft.owner ?? ""} onChange={(event) => setDraft({ ...draft, owner: event.target.value })} /></label>
    <label className="block space-y-1 text-xs">Project path<Input list="ticket-projects" value={draft.project ?? ""} onChange={(event) => setDraft({ ...draft, project: event.target.value })} /></label>
    <TicketSelect label="Priority" disabled={busy} value={draft.priority ?? "P2"} options={priorityOptions} onChange={(priority) => setDraft({ ...draft, priority: priority as Ticket["priority"] })} />
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Button type="submit" size="sm" disabled={busy || !draft.title.trim()}>Create ticket</Button>
    </fieldset>
  </form>;
}
function TicketDetail({ ticket, tickets, api, owners, projects, threads, onSaved, onSelect, onAddChild, onOpenThread }: {
  ticket: Ticket; tickets: Ticket[]; api: TicketApi; owners: string[]; projects: string[]; threads: Props["threads"];
  onSaved: (ticket: Ticket) => void; onSelect: (id: string) => void; onAddChild: () => void; onOpenThread: (id: string) => void;
}) {
  const [base, setBase] = useState(ticket);
  const [draft, setDraft] = useState(ticket);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const editableFields = ["title", "description", "state", "priority", "owner", "project", "closing_note", "linked_thread_ids"] as const;
    if (ticket !== base && editableFields.every((field) => JSON.stringify(draft[field]) === JSON.stringify(base[field]))) {
      setBase(ticket);
      setDraft(ticket);
    }
  }, [ticket, base, draft]);
  // A remote comment must not erase an unsaved edit. Compare with the editing
  // baseline and send only fields the user changed.
  const save = async () => {
    const args: UpdateTicketArgs = { ticket_id: ticket.id };
    for (const field of ["title", "description", "state", "priority", "owner", "project", "closing_note"] as const) {
      if (draft[field] !== base[field]) Object.assign(args, { [field]: draft[field] ?? "" });
    }
    if (JSON.stringify(draft.linked_thread_ids) !== JSON.stringify(base.linked_thread_ids)) args.linked_thread_ids = draft.linked_thread_ids.map((id) => id.trim()).filter(Boolean);
    if (closed(draft.state) && draft.state !== base.state) args.closing_note = draft.closing_note ?? "";
    const result = await api.updateTicket(args);
    setBase(result); setDraft(result); onSaved(result);
  };
  const run = (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    void action().catch((error) => setError(errorMessage(error))).finally(() => setBusy(false));
  };
  return <div className="space-y-5">
    <div className="text-xs text-fg-muted">{ticket.id} · Created by {ticket.created_by.name} · {ticketAge(ticket.created_at)} old</div>
    {ticket.parent_id && <Button variant="ghost" size="sm" onClick={() => onSelect(ticket.parent_id!)}>Parent {ticket.parent_id}</Button>}
    <ChoiceLists owners={owners} projects={projects} />
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); run(save); }}>
      <fieldset disabled={busy} className="contents">
      <label className="block space-y-1 text-xs">Title<Input required value={draft.title} maxLength={200} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <div className="flex flex-wrap gap-2"><TicketSelect label="State" value={draft.state} options={stateOptions} disabled={busy} onChange={(state) => setDraft({ ...draft, state: state as TicketState, closing_note: "" })} />
        <TicketSelect label="Priority" value={draft.priority} options={priorityOptions} disabled={busy} onChange={(priority) => setDraft({ ...draft, priority: priority as Ticket["priority"] })} /></div>
      <label className="block space-y-1 text-xs">Owner<Input list="ticket-owners" value={draft.owner ?? ""} onChange={(event) => setDraft({ ...draft, owner: event.target.value })} /></label>
      <label className="block space-y-1 text-xs">Project path<Input list="ticket-projects" value={draft.project ?? ""} onChange={(event) => setDraft({ ...draft, project: event.target.value })} /></label>
      {closed(draft.state) && <label className="block space-y-1 text-xs">Closing note<Input required maxLength={500} placeholder="One line saying the outcome" value={draft.closing_note ?? ""} onChange={(event) => setDraft({ ...draft, closing_note: event.target.value })} /></label>}
      <MessageMarkdown text={ticket.description || "No description yet."} interpretDirectives={false} />
      <details><summary className="cursor-pointer text-xs text-fg-secondary">Edit description and thread links</summary>
        <label className="mt-2 block space-y-1 text-xs">Description (Markdown)<Textarea rows={5} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="mt-2 block space-y-1 text-xs">Linked thread IDs (one per line)<Textarea value={draft.linked_thread_ids.join("\n")} onChange={(event) => setDraft({ ...draft, linked_thread_ids: event.target.value.split("\n") })} /></label>
      </details>
      <Button type="submit" size="sm" disabled={busy}>Save ticket</Button>
      </fieldset>
    </form>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <section className="space-y-2"><h3 className="text-xs font-semibold text-fg-secondary">Linked threads</h3>
      {ticket.linked_thread_ids.map((id) => <Button key={id} variant="ghost" size="sm" className="max-w-full truncate" onClick={() => onOpenThread(id)}>{threads?.find((thread) => thread.id === id)?.title ?? id}</Button>)}
      {ticket.linked_thread_ids.length === 0 && <p className="text-xs text-fg-muted">No linked threads.</p>}
    </section>
    <section className="space-y-2"><h3 className="text-xs font-semibold text-fg-secondary">Sub-tickets</h3>
      {tickets.filter((child) => child.parent_id === ticket.id).map((child) => <button key={child.id} type="button" className="fd-focus block w-full text-left text-sm text-fg-secondary" onClick={() => onSelect(child.id)}>{child.id} · {child.title} · {TICKET_STATE_LABELS[child.state]}</button>)}
      {!ticket.parent_id && <Button size="sm" variant="ghost" onClick={onAddChild}><Plus className="h-3 w-3" />Add sub-ticket</Button>}
    </section>
    <section className="space-y-3"><h3 className="text-xs font-semibold text-fg-secondary">Comments ({ticket.comments.length})</h3>
      {ticket.comments.map((entry) => <div key={entry.id} className="border-b border-border-subtle pb-3"><p className="mb-1 text-xs text-fg-muted">{entry.author.name} · {new Date(entry.created_at).toLocaleString()}</p><MessageMarkdown text={entry.body} interpretDirectives={false} /></div>)}
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); run(async () => { const result = await api.commentTicket(ticket.id, comment); onSaved(result); setComment(""); }); }}>
        <fieldset disabled={busy} className="contents">
        <Textarea aria-label="Comment" placeholder="Concise notes for the record (Markdown)" value={comment} onChange={(event) => setComment(event.target.value)} />
        <Button type="submit" size="sm" disabled={busy || !comment.trim()}>Add comment</Button>
        </fieldset>
      </form>
    </section>
  </div>;
}
