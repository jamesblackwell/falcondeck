import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ticket } from "@falcondeck/client-core";
import { TicketsView } from "./TicketsView";

// jsdom lacks pointer capture. Keep production Radix menus out of these
// interaction tests; exercise the board's selected values and handlers.
vi.mock("@falcondeck/ui", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const Context = React.createContext<{ value: string; onValueChange: (value: string) => void; disabled?: boolean } | null>(null);
  return { ...actual,
    Select: ({ children, ...props }: { children: React.ReactNode; value: string; onValueChange: (value: string) => void; disabled?: boolean }) => <Context.Provider value={props}>{children}</Context.Provider>,
    SelectTrigger: ({ "aria-label": label }: { "aria-label": string }) => {
      const context = React.useContext(Context)!;
      return <input aria-label={label} value={context.value} disabled={context.disabled} onChange={(event) => context.onValueChange(event.target.value)} />;
    },
    SelectValue: () => null, SelectContent: () => null, SelectItem: () => null,
  };
});
vi.mock("@falcondeck/chat-ui", () => ({ MessageMarkdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("../hooks/useControlStateEvents", () => ({ useControlStateEvents: vi.fn() }));
function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  const actor = { name: "James", context: { origin: "desktop_ui" as const } };
  return { id, title: `Project ${id}`, description: "Launch **plan**", state: "active", priority: "P1", owner: "Juno", project: "/company", parent_id: null,
    linked_thread_ids: ["thread-1"], created_by: actor, updated_by: actor, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T12:00:00Z", closing_note: null, comments: [], ...overrides };
}
function setup(rows = [ticket("T-1")]) {
  let records = rows;
  const api = {
    listTickets: vi.fn(async () => records),
    createTicket: vi.fn(async (args) => { const result = ticket("T-9", args); records = [...records, result]; return result; }),
    updateTicket: vi.fn(async ({ ticket_id, ...args }) => {
      const result = { ...records.find((row) => row.id === ticket_id)!, ...args };
      records = records.map((row) => row.id === ticket_id ? result : row); return result;
    }),
    commentTicket: vi.fn(async (id, body) => {
      const original = records.find((row) => row.id === id)!;
      const result = { ...original, comments: [...original.comments, { id: "comment-1", body, author: original.created_by, created_at: original.created_at }] };
      records = records.map((row) => row.id === id ? result : row); return result;
    }),
  };
  const onOpenThread = vi.fn();
  const view = render(<TicketsView api={api} baseUrl={null} owners={["Juno", "Vulcan"]} projects={["/company"]} threads={[{ id: "thread-1", title: "Launch task" }]} onOpenThread={onOpenThread} />);
  return { api, onOpenThread, rerender: view.rerender };
}
afterEach(cleanup);
describe("Tickets board", () => {
  it("hides closed tickets, shows metadata, and filters owner, project and priority", async () => {
    setup([ticket("T-1"), ticket("T-2", { state: "done", closing_note: "Shipped." }), ticket("T-3", { owner: "Vulcan", project: "/other", priority: "P3", parent_id: "T-1" })]);
    await screen.findByRole("button", { name: "T-1 Project T-1" });
    expect(screen.queryByRole("button", { name: "T-2 Project T-2" })).toBeNull();
    expect(screen.getByText("1 sub-tickets")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter owner"), { target: { value: "Juno" } });
    expect(screen.queryByRole("button", { name: "T-3 Project T-3" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter owner"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Filter project"), { target: { value: "/other" } });
    expect(screen.queryByRole("button", { name: "T-1 Project T-1" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter project"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Filter priority"), { target: { value: "P1" } });
    expect(screen.queryByRole("button", { name: "T-3 Project T-3" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Show done / dropped"));
    expect(screen.getByRole("button", { name: "T-2 Project T-2" })).toBeTruthy();
  });
  it("opens threads, comments, creates children and saves state with an outcome", async () => {
    const { api, onOpenThread } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "T-1 Project T-1" }));
    const detail = screen.getByRole("complementary", { name: "Ticket detail" });
    fireEvent.click(within(detail).getByRole("button", { name: "Launch task" }));
    expect(onOpenThread).toHaveBeenCalledWith("thread-1");
    fireEvent.change(within(detail).getByLabelText("Comment"), { target: { value: "Budget approved." } });
    fireEvent.click(within(detail).getByRole("button", { name: "Add comment" }));
    await within(detail).findByText("Budget approved.");
    expect(api.commentTicket).toHaveBeenCalledWith("T-1", "Budget approved.");
    await waitFor(() => expect(within(detail).getByRole("button", { name: "Save ticket" }).hasAttribute("disabled")).toBe(false));
    fireEvent.change(within(detail).getByLabelText("State"), { target: { value: "done" } });
    fireEvent.change(within(detail).getByLabelText("Closing note"), { target: { value: "Launch complete." } });
    fireEvent.click(within(detail).getByRole("button", { name: "Save ticket" }));
    await waitFor(() => expect(api.updateTicket).toHaveBeenCalledWith({ ticket_id: "T-1", state: "done", closing_note: "Launch complete." }));
    fireEvent.click(within(detail).getByRole("button", { name: "Add sub-ticket" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Launch reporting" } });
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith(expect.objectContaining({ title: "Launch reporting", parent_id: "T-1" })));
  });
  it("shows mutation failures and retains the comment draft", async () => {
    const { api } = setup();
    api.commentTicket.mockRejectedValueOnce(new Error("Tickets storage: disk full"));
    fireEvent.click(await screen.findByRole("button", { name: "T-1 Project T-1" }));
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep this note." } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(screen.getByLabelText("Comment")).toHaveValue("Keep this note.");
  });
  it("refreshes clean detail fields while preserving unsaved edits", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "T-1 Project T-1" }));
    api.listTickets.mockResolvedValueOnce([ticket("T-1", { owner: "Vulcan" })]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh tickets" }));
    await waitFor(() => expect(screen.getByLabelText("Owner")).toHaveValue("Vulcan"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsaved launch plan" } });
    api.listTickets.mockResolvedValueOnce([ticket("T-1", { owner: "James" })]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh tickets" }));
    await waitFor(() => expect(api.listTickets).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Title")).toHaveValue("Unsaved launch plan");
  });

  it.each(["create", "update", "comment"] as const)("locks submitted fields and ignores a stale %s completion after switching daemons", async (kind) => {
    const { api, rerender } = setup();
    await screen.findByRole("button", { name: "T-1 Project T-1" });
    let resolve!: (value: Ticket) => void;
    const pending = new Promise<Ticket>((done) => { resolve = done; });
    if (kind === "create") {
      api.createTicket.mockReturnValueOnce(pending);
      fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Old daemon project" } });
      fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "T-1 Project T-1" }));
      if (kind === "update") {
        api.updateTicket.mockReturnValueOnce(pending);
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Old daemon project" } });
        fireEvent.click(screen.getByRole("button", { name: "Save ticket" }));
      } else {
        api.commentTicket.mockReturnValueOnce(pending);
        fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Old daemon note" } });
        fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
      }
      expect(screen.getByLabelText("Comment")).toBeDisabled();
    }
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByLabelText("Owner")).toBeDisabled();
    const nextApi = { ...api, listTickets: vi.fn(async () => [ticket("T-1", { title: "New daemon project" })]) };
    rerender(<TicketsView api={nextApi} baseUrl="http://new-daemon" onOpenThread={vi.fn()} />);
    await screen.findByRole("button", { name: "T-1 New daemon project" });
    await act(async () => { resolve(ticket("T-1", { title: "Old daemon project" })); await pending; });
    expect(api.listTickets).toHaveBeenCalledTimes(1);
    expect(nextApi.listTickets).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "T-1 New daemon project" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Ticket detail" })).toBeNull();
  });

  it("creates a top-level ticket", async () => {
    const { api } = setup([]);
    fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Company launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith(expect.objectContaining({ title: "Company launch" })));
    expect(await screen.findByRole("button", { name: "T-9 Company launch" })).toBeTruthy();
  });
});
