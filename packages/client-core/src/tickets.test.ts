import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonApiClient } from "./daemon-client";

afterEach(() => vi.unstubAllGlobals());
describe("ticket daemon client", () => {
  it("loads every list page and preserves filters", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "T-1" }], next_cursor: "1" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "T-2" }], next_cursor: null })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createDaemonApiClient("http://daemon.test").listTickets({ owner: "Juno", include_closed: true })).toEqual([{ id: "T-1" }, { id: "T-2" }]);
    const second = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(second.searchParams.get("cursor")).toBe("1");
    expect(second.searchParams.get("owner")).toBe("Juno");
    expect(second.searchParams.get("include_closed")).toBe("true");
  });
  it("reports control envelope failures even with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { message: "Closing note required." } }))));
    await expect(createDaemonApiClient("http://daemon.test").updateTicket({ ticket_id: "T-1", state: "done" })).rejects.toThrow("Closing note required.");
  });
});
