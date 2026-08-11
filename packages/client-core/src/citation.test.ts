import { describe, expect, it } from "vitest";

import {
  citationDisplayLabel,
  citationExternalUrl,
  citationExcerptPreview,
  citationIdentity,
  citationLocatorLabel,
  citationRenderKeys,
  dedupeCitations,
} from "./citation";
import type { ConversationCitation } from "./types";

const locatedCitation = {
  kind: "search_result_location",
  source: "https://docs.example.com/guide",
  title: "Guide",
  cited_text: "Original excerpt",
  locator: {
    kind: "search_result",
    search_result_index: 2,
    start_block_index: 4,
    end_block_index: 5,
  },
} satisfies ConversationCitation;

describe("citation presentation", () => {
  it("opens a safe URL carried in search-result source metadata", () => {
    expect(citationExternalUrl(locatedCitation)).toBe(
      "https://docs.example.com/guide",
    );
  });

  it("does not treat a non-web source identifier as a link", () => {
    expect(
      citationExternalUrl({ ...locatedCitation, source: "kb://guide" }),
    ).toBeNull();
  });

  it("bounds untrusted labels and excerpts without changing the citation", () => {
    const citation = {
      ...locatedCitation,
      title: `Guide ${"x".repeat(500)}`,
      cited_text: `Evidence ${"y".repeat(3_000)}`,
    };

    expect(citationDisplayLabel(citation, 0)).toMatchObject({ limited: true });
    expect(citationDisplayLabel(citation, 0).text).toHaveLength(241);
    expect(citationExcerptPreview(citation)).toMatchObject({ limited: true });
    expect(citationExcerptPreview(citation)?.text).toHaveLength(2_001);
    expect(citation.title).toHaveLength(506);
    expect(citation.cited_text).toHaveLength(3_009);
  });

  it("humanizes exact search-result block locations", () => {
    expect(citationLocatorLabel(locatedCitation.locator)).toBe(
      "Result 3 · block 5",
    );
  });

  it("keeps renderer identity stable when display metadata changes", () => {
    const updated = {
      ...locatedCitation,
      title: "Updated guide",
      cited_text: "New excerpt",
    };

    expect(citationRenderKeys([updated])).toEqual(
      citationRenderKeys([locatedCitation]),
    );
  });

  it("uses a stable protocol id across complete metadata replacement", () => {
    const initial = {
      ...locatedCitation,
      id: "answer-1:citation:0",
      locator: null,
      title: null,
      cited_text: null,
    };
    const updated = {
      ...initial,
      url: "https://new.example.com/source",
      title: "Enriched source",
      cited_text: "New evidence",
    };

    expect(citationIdentity(updated)).toBe(citationIdentity(initial));
    expect(citationRenderKeys([updated])).toEqual(
      citationRenderKeys([initial]),
    );
  });

  it("deduplicates legacy URL citations when display metadata is enriched", () => {
    const initial = {
      kind: "web_search_result_location",
      url: "https://docs.example.com/guide",
    } satisfies ConversationCitation;
    const updated = {
      ...initial,
      title: "Guide",
      cited_text: "New excerpt",
    } satisfies ConversationCitation;

    expect(dedupeCitations([initial, updated])).toEqual([updated]);
    expect(citationIdentity(updated)).toBe(citationIdentity(initial));
  });

  it("deduplicates replayed locators while retaining the latest metadata", () => {
    const updated = { ...locatedCitation, cited_text: "New excerpt" };

    expect(dedupeCitations([locatedCitation, updated])).toEqual([updated]);
    expect(citationIdentity(updated)).toBe(citationIdentity(locatedCitation));
  });
});
