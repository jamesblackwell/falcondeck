import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonApiClient } from "./daemon-client";
import type { ProviderUsageOverview } from "./types";

describe("createDaemonApiClient sendTurn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads provider usage from the daemon usage endpoint", async () => {
    const overview: ProviderUsageOverview = {
      codex: {
        status: "ok",
        account_email: "dev@example.com",
        plan_label: "Pro",
        windows: [
          {
            label: "Current session",
            used_percent: 12,
            resets_at: "2026-08-18T22:00:00.000Z",
          },
        ],
      },
      claude_code: { status: "unauthenticated" },
    };
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(overview), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDaemonApiClient("http://daemon.test").providerUsage();

    expect(result).toEqual(overview);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://daemon.test/api/provider-usage",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("saves speech credentials only to the daemon credential endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ configured: true, storage: "daemon_secret_store" }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result =
      await createDaemonApiClient("http://daemon.test").saveSpeechCredential(
        "secret-key",
      );

    expect(result).toEqual({
      configured: true,
      storage: "daemon_secret_store",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://daemon.test/api/speech/openrouter-key",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
  });

  it("serializes the one-shot steer flag for a running follow-up", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createDaemonApiClient("http://daemon.test").sendTurn({
      workspace_id: "workspace",
      thread_id: "thread",
      inputs: [{ type: "text", text: "adjust the active turn" }],
      steer: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://daemon.test/api/workspaces/workspace/threads/thread/turns",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({ steer: true });
  });

  it("posts the complete queued message order", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createDaemonApiClient("http://daemon.test").reorderQueuedTurns(
      "workspace",
      "thread",
      ["queued-2", "queued-1"],
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://daemon.test/api/workspaces/workspace/threads/thread/queue/reorder",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      queued_ids: ["queued-2", "queued-1"],
    });
  });

  it("creates and updates daemon-owned scheduled tasks through host-scoped routes", async () => {
    const detail = {
      id: "scheduled-1",
      title: "Daily briefing",
      status: "active",
      schedule: {
        kind: "recurring",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        timezone: "Europe/London",
      },
      workspace_id: "workspace",
      provider: "codex",
      updated_at: "2026-08-13T09:00:00Z",
      prompt: "Prepare a briefing",
      isolation: "project_folder",
      selected_skills: [],
      created_at: "2026-08-13T09:00:00Z",
    };
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(detail), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createDaemonApiClient("http://daemon.test");

    await client.createScheduledTask({
      title: detail.title,
      prompt: detail.prompt,
      workspace_id: detail.workspace_id,
      provider: "codex",
      schedule: detail.schedule as {
        kind: "recurring";
        rrule: string;
        timezone: string;
      },
    });
    await client.updateScheduledTask("scheduled-1", {
      status: "paused",
      workspace_id: "workspace-2",
      provider: "claude",
      model_id: null,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://daemon.test/api/scheduled-tasks",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://daemon.test/api/scheduled-tasks/scheduled-1",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      status: "paused",
      workspace_id: "workspace-2",
      provider: "claude",
      model_id: null,
    });
  });

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

  it("posts suggest-title against the thread resource", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ title: "Billing webhook" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDaemonApiClient(
      "http://daemon.test",
    ).suggestThreadTitle("workspace", "thread");

    expect(result).toEqual({ title: "Billing webhook" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://daemon.test/api/workspaces/workspace/threads/thread/suggest-title",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });
});
