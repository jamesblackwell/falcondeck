/** Big-picture company work taking hours, days or weeks. Most changes should
 * just be done; never create tickets for anything under a few hours. */
import type { ControlRequestContext } from "./control";

export const TICKET_STATES = ["backlog", "active", "blocked", "waiting_on_james", "done", "dropped"] as const;
export type TicketState = typeof TICKET_STATES[number];
export const TICKET_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type TicketPriority = typeof TICKET_PRIORITIES[number];
export type TicketActor = { name: string; context: ControlRequestContext };
export type TicketComment = { id: string; author: TicketActor; body: string; created_at: string };
export type Ticket = {
  id: string;
  title: string;
  description: string;
  state: TicketState;
  priority: TicketPriority;
  owner: string | null;
  project: string | null;
  parent_id: string | null;
  linked_thread_ids: string[];
  created_by: TicketActor;
  updated_by: TicketActor;
  created_at: string;
  updated_at: string;
  closing_note: string | null;
  comments: TicketComment[];
};
export type CreateTicketArgs = Pick<Ticket, "title"> & Partial<Pick<Ticket,
  "description" | "state" | "priority" | "owner" | "project" | "parent_id" | "linked_thread_ids" | "closing_note">>;
/** Empty owner/project/parent_id clears it; omitted fields remain unchanged. */
export type UpdateTicketArgs = { ticket_id: string } & Partial<Omit<CreateTicketArgs, "title"> & { title: string }>;
export type TicketFilters = { owner?: string; project?: string; priority?: TicketPriority; state?: TicketState; include_closed?: boolean };
