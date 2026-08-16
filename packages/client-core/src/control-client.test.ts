import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonApiClient } from "./daemon-client";

describe("daemon client control routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts control searches with the full request body", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDaemonApiClient("http://daemon.test").controlSearch(
      { query: "create a scheduled task", detail: "full" },
    );

    expect(result).toEqual({ results: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://daemon.test/api/control/search");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "create a scheduled task",
      detail: "full",
    });
  });

  it("posts control gets with resource and pagination", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ resource: "automations", data: [], next_cursor: null }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDaemonApiClient("http://daemon.test").controlGet({
      resource: "automations",
      limit: 50,
    });

    expect(result.resource).toBe("automations");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://daemon.test/api/control/get");
    expect(JSON.parse(String(init?.body))).toEqual({
      resource: "automations",
      limit: 50,
    });
  });

  it("returns the execute envelope including structured errors", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            operation: "automation.update",
            error: {
              code: "revision_conflict",
              message: "Automation changed after it was read.",
              retryable: true,
              field_errors: [],
              current_revision: 4,
              suggested_action: "Retry with expected_revision 4.",
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDaemonApiClient(
      "http://daemon.test",
    ).controlExecute({
      operation: "automation.update",
      arguments: { automation_id: "automation-1", name: "x" },
      expected_revision: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("revision_conflict");
    expect(result.error?.current_revision).toBe(4);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      operation: "automation.update",
      arguments: { automation_id: "automation-1", name: "x" },
      expected_revision: 2,
    });
  });
});
