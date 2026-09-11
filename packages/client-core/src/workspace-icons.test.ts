import { describe, expect, it } from "vitest";

import {
  domainFromUserInput,
  normalizeWorkspaceIconPreference,
  normalizeWorkspaceIcons,
  normalizeWorkspaceResolvedIcon,
  sanitizeLogoDomain,
  workspaceIconPreference,
  workspaceIconUrl,
} from "./workspace-icons";

describe("workspace icons", () => {
  it("sanitizes hostnames the same way plugin logos do", () => {
    expect(sanitizeLogoDomain("GitHub.COM.")).toBe("github.com");
    expect(sanitizeLogoDomain("../etc/passwd")).toBeNull();
    expect(sanitizeLogoDomain("notion.so/logo")).toBeNull();
    expect(sanitizeLogoDomain("localhost")).toBeNull();
  });

  it("drops blank ids, invalid domains, and later duplicates", () => {
    expect(
      normalizeWorkspaceIcons({
        " workspace-a ": { mode: "domain", domain: "Lucidpic.com." },
        "workspace-a": { mode: "folder" },
        "workspace-b": { mode: "domain", domain: "not a host" },
        "": { mode: "auto" },
        "workspace-c": { mode: "auto", domain: "ignored.example" },
      }),
    ).toEqual({
      "workspace-a": { mode: "domain", domain: "lucidpic.com" },
      "workspace-c": { mode: "auto" },
    });
  });

  it("rejects unknown modes", () => {
    expect(normalizeWorkspaceIconPreference({ mode: "upload" })).toBeNull();
    expect(normalizeWorkspaceIconPreference(null)).toBeNull();
  });

  it("treats a missing preference as auto", () => {
    expect(workspaceIconPreference({}, "workspace-a")).toEqual({ mode: "auto" });
  });

  it("builds a cache-busted daemon icon URL", () => {
    expect(
      workspaceIconUrl("http://127.0.0.1:4123", "w1", {
        kind: "image",
        etag: "abc",
      }),
    ).toBe("http://127.0.0.1:4123/api/workspace-icons/w1?v=abc");
    expect(workspaceIconUrl("http://127.0.0.1:4123", "w1", { kind: "folder" })).toBeNull();
    expect(
      workspaceIconUrl(
        "http://127.0.0.1:4123",
        "w1",
        { kind: "image", etag: "abc" },
        { mode: "folder" },
      ),
    ).toBeNull();
  });

  it("accepts a pasted website URL as a domain", () => {
    expect(domainFromUserInput("https://Lucidpic.com/app")).toBe("lucidpic.com");
    expect(domainFromUserInput("lucidpic.com")).toBe("lucidpic.com");
    expect(domainFromUserInput("not a host")).toBeNull();
  });

  it("normalizes resolved icons from older or partial payloads", () => {
    expect(normalizeWorkspaceResolvedIcon({ kind: "folder" })).toEqual({
      kind: "folder",
    });
    expect(
      normalizeWorkspaceResolvedIcon({
        kind: "image",
        etag: "abc",
        source: "domain",
        domain: "Example.COM.",
      }),
    ).toEqual({
      kind: "image",
      etag: "abc",
      source: "domain",
      domain: "example.com",
    });
    expect(normalizeWorkspaceResolvedIcon({ kind: "unknown" })).toBeNull();
  });
});
