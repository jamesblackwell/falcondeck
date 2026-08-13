import { describe, expect, it } from "vitest";

import {
  deriveExtensionSidebarFilters,
  filterProjectGroupsByExtensions,
  normalizeExtensionUiDocument,
} from "./extension-ui";
import { normalizeExtensionSnapshot } from "./normalization";
import type {
  ExtensionSnapshot,
  ExtensionUiDocument,
  ThreadSummary,
  WorkspaceSummary,
} from "./types";
import type { ProjectGroup } from "./grouping";

const filterDocument: ExtensionUiDocument = {
  version: 1,
  root: {
    type: "select",
    id: "colors",
    label: "Filter by colour",
    multiple: true,
    options: [
      { value: "red", label: "Red", tone: "red" },
      { value: "blue", label: "Blue", tone: "blue" },
    ],
    binding: {
      view: "thread-tags",
      path: ["tagIds"],
      operator: "includes_any",
    },
  },
};

function extensionSnapshot(): ExtensionSnapshot {
  return {
    catalog: [
      {
        id: "example.colors",
        name: "Colours",
        version: "1.0.0",
        source: "bundled",
        bundled: true,
        enabled: true,
        status: "active",
        contributes: {
          threadMenuActions: [],
          threadDecorations: [{ id: "chips", view: "thread-tags" }],
          sidebarFilters: [
            {
              id: "colors",
              title: "Colours",
              view: "tag-index",
              ui: filterDocument,
            },
          ],
        },
        permissions: [],
      },
    ],
    views: [
      {
        extension_id: "example.colors",
        view_id: "thread-tags",
        scope: { kind: "thread", id: "red-thread" },
        value: { tagIds: ["red"] },
        updated_at: "2026-08-13T00:00:00Z",
      },
    ],
  };
}

describe("normalizeExtensionUiDocument", () => {
  it("accepts the bounded v1 component and binding vocabulary", () => {
    expect(normalizeExtensionUiDocument(filterDocument)).toEqual({
      ok: true,
      document: filterDocument,
    });
  });

  it("keeps a newer vocabulary version visible as an unsupported reason", () => {
    expect(
      normalizeExtensionUiDocument({ ...filterDocument, version: 2 }),
    ).toEqual({
      ok: false,
      reason: "Declarative UI v2 is not supported by this client",
    });
  });

  it("rejects prototype traversal in declarative filter paths", () => {
    const document = structuredClone(filterDocument);
    if (document.root.type === "select")
      document.root.binding.path = ["__proto__"];

    expect(normalizeExtensionUiDocument(document)).toEqual({
      ok: false,
      reason: "Declarative UI is malformed or exceeds client limits",
    });
  });

  it("counts Unicode code points consistently with Rust and JSON Schema", () => {
    expect(
      normalizeExtensionUiDocument({
        version: 1,
        root: { type: "text", text: "🦅".repeat(4_096) },
      }).ok,
    ).toBe(true);
    expect(
      normalizeExtensionUiDocument({
        version: 1,
        root: { type: "text", text: "🦅".repeat(4_097) },
      }).ok,
    ).toBe(false);
  });

  it("rejects action bindings whose literal input exceeds the daemon limit", () => {
    expect(
      normalizeExtensionUiDocument({
        version: 1,
        root: {
          type: "button",
          label: "Run",
          action: {
            actionId: "run",
            input: "x".repeat(64 * 1024),
          },
        },
      }).ok,
    ).toBe(false);
  });
});

describe("deriveExtensionSidebarFilters", () => {
  it("renders a manifest fallback before the lazy host publishes global state", () => {
    const definitions = deriveExtensionSidebarFilters(extensionSnapshot());

    expect(definitions).toEqual([
      expect.objectContaining({
        key: "example.colors:colors",
        document: filterDocument,
        unsupportedReason: null,
      }),
    ]);
  });

  it("uses a synchronized global document in preference to the manifest fallback", () => {
    const snapshot = extensionSnapshot();
    snapshot.views.push({
      extension_id: "example.colors",
      view_id: "tag-index",
      value: {
        ...filterDocument,
        root: { ...filterDocument.root, label: "Published filter" },
      },
      updated_at: "2026-08-13T00:00:01Z",
    });

    expect(
      deriveExtensionSidebarFilters(snapshot)[0]?.document?.root,
    ).toMatchObject({ type: "select", label: "Published filter" });
  });

  it("does not mistake ordinary versioned projection data for a UI document", () => {
    const snapshot = extensionSnapshot();
    snapshot.views.push({
      extension_id: "example.colors",
      view_id: "tag-index",
      value: { version: 1, tags: [] },
      updated_at: "2026-08-13T00:00:01Z",
    });

    expect(deriveExtensionSidebarFilters(snapshot)[0]?.document).toEqual(
      filterDocument,
    );
  });

  it("retains a newer manifest UI version as an inspectable fallback", () => {
    const raw = extensionSnapshot() as unknown as Record<string, unknown>;
    const catalog = raw.catalog as Array<Record<string, unknown>>;
    const contributes = catalog[0]?.contributes as Record<string, unknown>;
    const filters = contributes.sidebarFilters as Array<
      Record<string, unknown>
    >;
    filters[0]!.ui = { ...filterDocument, version: 2 };

    const definitions = deriveExtensionSidebarFilters(
      normalizeExtensionSnapshot(raw),
    );

    expect(definitions[0]).toMatchObject({
      document: null,
      unsupportedReason: "Declarative UI v2 is not supported by this client",
    });
  });

  it("removes disabled extension filters without a client reload", () => {
    const snapshot = extensionSnapshot();
    snapshot.catalog[0]!.enabled = false;

    expect(deriveExtensionSidebarFilters(snapshot)).toEqual([]);
  });

  it("leaves legacy sidebar contributions to their compatibility adapter", () => {
    const snapshot = extensionSnapshot();
    snapshot.catalog[0]!.contributes.sidebarFilters[0]!.ui = null;
    snapshot.views.push({
      extension_id: "example.colors",
      view_id: "tag-index",
      value: { version: 1, tags: [] },
      updated_at: "2026-08-13T00:00:01Z",
    });

    expect(deriveExtensionSidebarFilters(snapshot)).toEqual([]);
  });
});

describe("filterProjectGroupsByExtensions", () => {
  it("matches selected values against bounded thread-scoped projections", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: { id: "workspace-1", path: "/project" } as WorkspaceSummary,
        threads: [
          { id: "red-thread", workspace_id: "workspace-1" } as ThreadSummary,
          { id: "plain-thread", workspace_id: "workspace-1" } as ThreadSummary,
        ],
      },
    ];

    const filtered = filterProjectGroupsByExtensions(
      groups,
      extensionSnapshot(),
      [
        {
          key: "example.colors:colors",
          extensionId: "example.colors",
          binding: {
            view: "thread-tags",
            path: ["tagIds"],
            operator: "includes_any",
          },
          selectedValues: new Set(["red"]),
        },
      ],
    );

    expect(filtered[0]?.threads.map((thread) => thread.id)).toEqual([
      "red-thread",
    ]);
  });
});
