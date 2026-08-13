import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonApiClient } from "./daemon-client";

describe("extension permission client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("updates one explicit extension permission grant", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: "example.reader",
            name: "Reader",
            version: "1.0.0",
            source: "bundled",
            bundled: true,
            enabled: true,
            status: "active",
            contributes: {},
            permissions: ["threads:read"],
            granted_permissions: ["threads:read"],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createDaemonApiClient("http://daemon.test").updateExtensionPermission(
      "example.reader",
      "threads:read",
      true,
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://daemon.test/api/extensions/example.reader/permissions",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      permission: "threads:read",
      granted: true,
    });
  });
});
