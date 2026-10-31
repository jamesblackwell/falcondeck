import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CloudJob, ThreadSummary } from "@falcondeck/client-core";
import type { CloudApi } from "./cloud-api";
import { CloudConversationStatus } from "./CloudConversationStatus";

const job = (id = "job-1") => ({
  id, status: "stopped", error: null,
  source: { included_paths: ["src/app.ts"], excluded_paths: [".env"] },
  result: { changed_paths: ["src/app.ts"], deleted_paths: [], imported_at: null },
}) as CloudJob;
const thread = (id = "job-1") => ({
  id, execution_target: "cloud", cloud: { job_id: id, status: "stopped", has_result: true, error: null },
}) as ThreadSummary;
const makeApi = () => ({ job: vi.fn().mockResolvedValue(job()), importResult: vi.fn().mockResolvedValue({ ...job(), result: { ...job().result, imported_at: "2026-10-31" } }) }) as unknown as CloudApi & { job: ReturnType<typeof vi.fn>; importResult: ReturnType<typeof vi.fn> };

describe("CloudConversationStatus", () => {
  it("keeps follow-ups in the normal composer and imports only after confirmation", async () => {
    const api = makeApi();
    const changed = vi.fn();
    render(<CloudConversationStatus thread={thread()} api={api} onChanged={changed} />);
    expect(screen.getByText(/send a message to continue/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resume/ })).not.toBeInTheDocument();
    const button = await screen.findByRole("button", { name: "Import changes…", hidden: true });
    fireEvent.click(button);
    expect(api.importResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply to project", hidden: true }));
    await waitFor(() => expect(api.importResult).toHaveBeenCalledWith("job-1"));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  });
  it("never imports without the owning host connection", async () => {
    render(<CloudConversationStatus thread={thread()} api={null} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Import changes…", hidden: true })).not.toBeInTheDocument();
  });
  it("ignores a stale previous task detail response", async () => {
    const api = makeApi();
    let resolve!: (result: CloudJob) => void;
    api.job.mockImplementationOnce(() => new Promise<CloudJob>((done) => { resolve = done; }));
    api.job.mockResolvedValueOnce({ ...job("job-2"), result: null });
    const { rerender } = render(<CloudConversationStatus thread={thread()} api={api} onChanged={vi.fn()} />);
    rerender(<CloudConversationStatus thread={thread("job-2")} api={api} onChanged={vi.fn()} />);
    await waitFor(() => expect(api.job).toHaveBeenCalledWith("job-2"));
    await act(async () => { resolve(job()); });
    expect(screen.queryByRole("button", { name: "Import changes…", hidden: true })).not.toBeInTheDocument();
  });
});
