import { afterEach, describe, expect, it, vi } from "vitest";

import { captureReaderAnchor, readerAnchorDrift } from "./reader-anchor";

function rect(top: number, height = 20) {
  return { top, bottom: top + height, height } as DOMRect;
}

function place(element: Element, top: () => number) {
  element.getBoundingClientRect = () => rect(top());
}

function transcript() {
  const scroll = document.createElement("div");
  scroll.innerHTML = `
    <div data-conversation-block-id="assistant_message:a">
      <div class="fd-markdown"><h2>Opening</h2><p>Second paragraph</p></div>
    </div>`;
  document.body.append(scroll);
  scroll.getBoundingClientRect = () => rect(100, 600);
  return scroll;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("reader anchor", () => {
  it("anchors the readable child under the top edge and reports its drift", () => {
    const scroll = transcript();
    const paragraph = scroll.querySelector("p")!;
    let top = 150;
    place(paragraph, () => top);
    document.elementFromPoint = () => paragraph;

    const anchor = captureReaderAnchor(scroll)!;
    expect(anchor.element).toBe(paragraph);
    expect(anchor.top).toBe(50);

    top = 210;
    expect(readerAnchorDrift(anchor, scroll)).toBe(60);
  });

  it("steps over gaps that hit no block", () => {
    const scroll = transcript();
    const paragraph = scroll.querySelector("p")!;
    place(paragraph, () => 150);
    const hits = [scroll, paragraph];
    document.elementFromPoint = () => hits.shift() ?? null;
    expect(captureReaderAnchor(scroll)?.element).toBe(paragraph);
  });

  it("ignores hits outside the scroller, such as overlays", () => {
    const scroll = transcript();
    document.elementFromPoint = () => document.body;
    expect(captureReaderAnchor(scroll)).toBeNull();
  });

  it("follows content into the element that replaced it", () => {
    const scroll = transcript();
    const original = scroll.querySelector("p")!;
    place(original, () => 150);
    document.elementFromPoint = () => original;
    const anchor = captureReaderAnchor(scroll)!;

    // Streaming blocks settle into a freshly rendered tree on completion.
    const markdown = scroll.querySelector(".fd-markdown")!;
    markdown.innerHTML =
      "<h2>Opening</h2><ul><li>New list</li></ul><p>Second paragraph</p>";
    const replacement = scroll.querySelector("p")!;
    place(replacement, () => 190);

    expect(readerAnchorDrift(anchor, scroll)).toBe(40);
    expect(anchor.element).toBe(replacement);
  });

  it("reports no drift once the anchored block has gone", () => {
    const scroll = transcript();
    const paragraph = scroll.querySelector("p")!;
    place(paragraph, () => 150);
    document.elementFromPoint = () => paragraph;
    const anchor = captureReaderAnchor(scroll)!;
    scroll.innerHTML = "";
    expect(readerAnchorDrift(anchor, scroll)).toBeNull();
  });

  it("reports nothing rather than guess when the content has changed", () => {
    const scroll = transcript();
    const paragraph = scroll.querySelector("p")!;
    place(paragraph, () => 150);
    document.elementFromPoint = () => paragraph;
    const anchor = captureReaderAnchor(scroll)!;
    scroll.querySelector(".fd-markdown")!.innerHTML = "<p>Something else</p>";
    expect(readerAnchorDrift(anchor, scroll)).toBeNull();
  });

  it("re-binds repeated content to the occurrence nearest the old one", () => {
    const scroll = transcript();
    const markdown = scroll.querySelector(".fd-markdown")!;
    markdown.innerHTML = "<p>Same</p><p>Other</p><p>Same</p>";
    const later = markdown.querySelectorAll("p")[2]!;
    place(later, () => 150);
    document.elementFromPoint = () => later;
    const anchor = captureReaderAnchor(scroll)!;

    markdown.innerHTML = "<p>Same</p><p>Other</p><p>Same</p>";
    const paragraphs = markdown.querySelectorAll("p");
    place(paragraphs[0]!, () => 10);
    place(paragraphs[2]!, () => 170);
    expect(readerAnchorDrift(anchor, scroll)).toBe(20);
  });
});
