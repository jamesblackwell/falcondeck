import { describe, expect, it } from "vitest";

import {
  formatDurationMs,
  extensionToolResultIdentity,
  guardianReviewPresentation,
  imageInputLabel,
  inspectMcpResult,
  isSafeExternalUrl,
  safeExternalUrl,
  isSafeMediaUrl,
  isSafeNativeImageUrl,
  parseMcpResult,
  summarizeMcpArtifacts,
  summarizeParsedMcpArtifacts,
} from "./provider-output";

describe("parseMcpResult", () => {
  it("identifies FalconDeck extension-tool results without parsing tool names", () => {
    expect(
      extensionToolResultIdentity({
        _meta: {
          "falcondeck/extensionTool": {
            extensionId: "falcondeck.missions",
            toolId: "draft-mission",
          },
        },
      }),
    ).toEqual({
      extensionId: "falcondeck.missions",
      toolId: "draft-mission",
    });
    expect(extensionToolResultIdentity({ _meta: { trace: "abc" } })).toBeNull();
  });
  it("reuses the parsed view of an immutable provider result", () => {
    const result = {
      content: [
        { type: "resource_link", uri: "https://example.com", name: "Example" },
      ],
    };

    expect(parseMcpResult(result)).toBe(parseMcpResult(result));
  });

  it("inspects collapsed-result signals without decoding rich payload details", () => {
    let iconReads = 0;
    let blobReads = 0;
    const result = {
      content: [
        { type: "text", text: "Canonical output" },
        {
          type: "resource_link",
          uri: "https://example.com/reference",
          name: "Reference",
          get icons() {
            iconReads += 1;
            return [{ src: "https://example.com/icon.png" }];
          },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/report.pdf",
            get blob() {
              blobReads += 1;
              return "aGVsbG8=";
            },
          },
        },
      ],
    };

    const inspection = inspectMcpResult(result);
    expect(inspectMcpResult(result)).toBe(inspection);
    expect(inspection).toEqual({
      has_text_content: true,
      artifacts: {
        total: 2,
        resource_links: 1,
        embedded_resources: 1,
        images: 0,
        audio: 0,
        structured_results: 0,
      },
    });
    expect(summarizeMcpArtifacts(result)).toBe(inspection.artifacts);
    expect({ iconReads, blobReads }).toEqual({ iconReads: 0, blobReads: 0 });

    parseMcpResult(result);
    expect(iconReads).toBeGreaterThan(0);
    expect(blobReads).toBeGreaterThan(0);
  });

  it("uses daemon summary metadata without inspecting the raw result", () => {
    let contentReads = 0;
    const result = {
      get content() {
        contentReads += 1;
        throw new Error(
          "collapsed presentation must not inspect provider content",
        );
      },
    };
    const summary = {
      text_blocks: 2,
      images: 1,
      audio: 0,
      resource_links: 3,
      embedded_resources: 1,
      structured_results: 1,
    };

    const inspection = inspectMcpResult(result, summary);
    expect(inspectMcpResult(result, summary)).toBe(inspection);
    expect(inspection).toEqual({
      has_text_content: true,
      artifacts: {
        total: 6,
        resource_links: 3,
        embedded_resources: 1,
        images: 1,
        audio: 0,
        structured_results: 1,
      },
    });
    expect(summarizeMcpArtifacts(result, summary)).toBe(inspection.artifacts);
    expect(contentReads).toBe(0);
  });

  it("preserves ordered rich content and supplemental result fields", () => {
    const parsed = parseMcpResult({
      content: [
        { type: "text", text: "Found three pages" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
        {
          type: "resource_link",
          uri: "https://example.com/page",
          name: "Page",
          title: "Result",
          size: 2048,
          annotations: { priority: 0.8 },
          _meta: { provider: "search" },
          icons: [
            {
              src: "https://example.com/icon.png",
              mimeType: "image/png",
              sizes: "32x32",
              theme: "dark",
            },
          ],
        },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/result.bin",
            mimeType: "application/octet-stream",
            blob: "aGVsbG8=",
            _meta: { version: 2 },
          },
        },
        { type: "future", payload: 7 },
      ],
      structuredContent: { count: 3 },
      _meta: { trace: "abc" },
      isError: false,
    });

    expect(parsed.content.map((item) => item.kind)).toEqual([
      "text",
      "image",
      "audio",
      "resource_link",
      "resource",
      "unknown",
    ]);
    expect(parsed.content[1]).toMatchObject({
      kind: "image",
      url: "data:image/png;base64,aGVsbG8=",
    });
    expect(parsed.content[3]).toMatchObject({
      kind: "resource_link",
      size: 2048,
      annotations: { priority: 0.8 },
      metadata: { provider: "search" },
      icons: [
        {
          src: "https://example.com/icon.png",
          mime_type: "image/png",
          sizes: "32x32",
          theme: "dark",
        },
      ],
    });
    expect(parsed.content[4]).toMatchObject({
      kind: "resource",
      blob_url: "data:application/octet-stream;base64,aGVsbG8=",
      byte_size: 5,
      metadata: { version: 2 },
    });
    expect(parsed.structured_content).toEqual({ count: 3 });
    expect(parsed.metadata).toEqual({ trace: "abc" });
    expect(parsed.extra).toEqual({ isError: false });
    expect(summarizeParsedMcpArtifacts(parsed)).toEqual({
      total: 5,
      resource_links: 1,
      embedded_resources: 1,
      images: 1,
      audio: 1,
      structured_results: 1,
    });
  });

  it("keeps lightweight artifact counts aligned with full parsing", () => {
    const result = {
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "image", data: "not base64!", mimeType: "image/png" },
        { type: "audio", url: "https://example.com/audio.wav" },
        {
          type: "resource_link",
          uri: "https://example.com/page",
          name: "Page",
        },
        { type: "resource_link", uri: "https://example.com/missing-name" },
        {
          type: "resource",
          resource: { uri: "file:///tmp/report.pdf", blob: "not base64!" },
        },
        { type: "resource", resource: { text: "missing uri" } },
      ],
      structured_content: { count: 3 },
    };

    expect(summarizeMcpArtifacts(result)).toEqual(
      summarizeParsedMcpArtifacts(parseMcpResult(result)),
    );
  });

  it("only permits appropriate media and external URL schemes", () => {
    expect(isSafeMediaUrl("data:image/png;base64,aGVsbG8=", "image")).toBe(
      true,
    );
    expect(isSafeMediaUrl("data:audio/wav;base64,aGVsbG8=", "audio")).toBe(
      true,
    );
    expect(
      isSafeMediaUrl("  https://example.com/image.png?token=signed  ", "image"),
    ).toBe(true);
    expect(
      isSafeMediaUrl(
        "blob:https://example.com/6d91d51d-30bb-4ebd-ae3b",
        "image",
      ),
    ).toBe(true);
    expect(
      isSafeMediaUrl("blob:tauri://localhost/6d91d51d-30bb-4ebd-ae3b", "image"),
    ).toBe(true);
    expect(isSafeMediaUrl("blob:null/6d91d51d-30bb-4ebd-ae3b", "image")).toBe(
      true,
    );
    expect(isSafeMediaUrl("javascript:alert(1)", "image")).toBe(false);
    expect(
      isSafeMediaUrl("https://user:secret@example.com/image.png", "image"),
    ).toBe(false);
    expect(
      isSafeMediaUrl("https://example.com/image.png\nignored", "image"),
    ).toBe(false);
    expect(isSafeMediaUrl("blob:javascript:alert(1)", "image")).toBe(false);
    expect(
      isSafeMediaUrl("data:image/png;base64,<svg onload=alert(1)>", "image"),
    ).toBe(false);
    expect(isSafeMediaUrl("data:image/png;base64,AAAA===", "image")).toBe(
      false,
    );
    expect(isSafeMediaUrl("data:image/png;base64,A", "image")).toBe(false);
    expect(isSafeMediaUrl("data:image/png;base64,AAAA=", "image")).toBe(false);
    expect(isSafeExternalUrl("https://example.com")).toBe(true);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("https://")).toBe(false);
    expect(isSafeExternalUrl("https://user:secret@example.com/source")).toBe(
      false,
    );
    expect(isSafeExternalUrl("https://example.com/\nsource")).toBe(false);
    expect(safeExternalUrl("  https://example.com/source  ")).toBe(
      "https://example.com/source",
    );
    expect(
      safeExternalUrl("https://user:secret@example.com/source"),
    ).toBeNull();
  });

  it("retains valid MIME-less binary resources and rejects malformed base64", () => {
    const parsed = parseMcpResult({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///tmp/result.bin", blob: "aGVsbG8=" },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/invalid.bin",
            mimeType: "application/octet-stream",
            blob: "not base64!",
          },
        },
        {
          type: "resource",
          resource: { uri: "file:///tmp/short.bin", blob: "A" },
        },
        {
          type: "resource",
          resource: { uri: "file:///tmp/padding.bin", blob: "AAAA=" },
        },
      ],
    });

    expect(parsed.content[0]).toMatchObject({
      kind: "resource",
      mime_type: null,
      blob_url: "data:application/octet-stream;base64,aGVsbG8=",
      byte_size: 5,
    });
    expect(parsed.content[1]).toMatchObject({
      kind: "resource",
      blob_url: null,
      byte_size: null,
    });
    expect(parsed.content[2]).toMatchObject({
      blob_url: null,
      byte_size: null,
    });
    expect(parsed.content[3]).toMatchObject({
      blob_url: null,
      byte_size: null,
    });
  });

  it("permits picker-local images only through the native media policy", () => {
    expect(isSafeNativeImageUrl("file:///private/tmp/photo.jpg")).toBe(true);
    expect(isSafeNativeImageUrl("content://media/external/images/7")).toBe(
      true,
    );
    expect(isSafeNativeImageUrl("ph://A1B2C3")).toBe(true);
    expect(isSafeNativeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeMediaUrl("file:///private/tmp/photo.jpg", "image")).toBe(
      false,
    );
  });

  it("derives the same compact image label for every client", () => {
    const image = {
      type: "image" as const,
      id: "image-1",
      name: null,
      mime_type: "image/png",
      url: "https://example.com/uploads/reference%20image.png?token=secret",
      local_path: null,
    };

    expect(imageInputLabel(image)).toBe("reference image.png");
    expect(imageInputLabel({ ...image, name: "  chosen.png  " })).toBe(
      "chosen.png",
    );
    expect(
      imageInputLabel({ ...image, url: "data:image/png;base64,abc" }),
    ).toBe("Image");
  });

  it("formats runner durations compactly across clients", () => {
    expect(formatDurationMs(42)).toBe("42 ms");
    expect(formatDurationMs(2_690)).toBe("2.7 s");
    expect(formatDurationMs(73_000)).toBe("1m 13s");
  });
});

describe("guardianReviewPresentation", () => {
  const detail = {
    kind: "guardian_review" as const,
    review_id: "review-1",
    action_kind: "networkAccess",
    action: "https://example.com",
    cwd: null,
    target_item_id: "tool-1",
    status: "inProgress",
    risk_level: "critical",
    user_authorization: null,
    rationale: null,
    decision_source: "userPolicy",
    duration_ms: null,
  };

  it("normalizes active state and provider metadata for every client", () => {
    expect(guardianReviewPresentation(detail)).toEqual({
      statusLabel: "Reviewing",
      actionKindLabel: "Network access",
      decisionSourceLabel: "User policy",
      active: true,
      urgent: true,
    });
  });

  it.each([
    ["approved", "Approved", false],
    ["denied", "Denied", true],
    ["timedOut", "Timed out", false],
    ["aborted", "Aborted", false],
    ["futureState", "Future state", false],
  ])("keeps %s review state intelligible", (status, statusLabel, urgent) => {
    expect(
      guardianReviewPresentation({
        ...detail,
        status,
        risk_level: null,
      }),
    ).toMatchObject({ statusLabel, active: false, urgent });
  });
});
