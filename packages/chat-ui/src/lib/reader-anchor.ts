/// Keeps what a detached reader is looking at in place when content above it
/// changes height. Chromium does this natively with `overflow-anchor`; WebKit,
/// which hosts the desktop app, does not support it.

const BLOCK_SELECTOR = "[data-conversation-block-id]";
const READABLE_SELECTOR = ".fd-markdown > *";
const KEY_LENGTH = 48;
// Hit-test down from the top edge, stepping over the gaps between blocks.
const FIRST_PROBE_PX = 8;
const PROBE_STEP_PX = 48;

/** Where the engine anchors for itself, a script correction on top of that
    would move the content twice. */
export function engineAnchorsScrolling() {
  return typeof CSS !== "undefined" && CSS.supports?.("overflow-anchor", "auto");
}

export type ReaderAnchor = {
  element: HTMLElement;
  /** Distance from the scroller's top edge. */
  top: number;
  blockId: string | null;
  /** Find the same content again if a re-render replaces the element. */
  key: string;
  index: number;
};

const textKey = (element: Element) =>
  (element.textContent ?? "").slice(0, KEY_LENGTH);

const readableChildren = (block: Element) =>
  Array.from(block.querySelectorAll<HTMLElement>(READABLE_SELECTOR));

const topWithin = (element: HTMLElement, scroll: HTMLElement) =>
  element.getBoundingClientRect().top - scroll.getBoundingClientRect().top;

export function captureReaderAnchor(scroll: HTMLElement): ReaderAnchor | null {
  const box = scroll.getBoundingClientRect();
  const x = box.left + box.width / 2;
  for (
    let y = box.top + FIRST_PROBE_PX;
    y < box.top + box.height / 2;
    y += PROBE_STEP_PX
  ) {
    const hit = scroll.ownerDocument.elementFromPoint?.(x, y);
    if (!hit || !scroll.contains(hit)) continue;
    const block = hit.closest<HTMLElement>(BLOCK_SELECTOR);
    if (!block) continue;
    const element = hit.closest<HTMLElement>(READABLE_SELECTOR) ?? block;
    return {
      element,
      top: topWithin(element, scroll),
      blockId: block.dataset.conversationBlockId ?? null,
      key: textKey(element),
      index: element === block ? -1 : readableChildren(block).indexOf(element),
    };
  }
  return null;
}

function reattach(anchor: ReaderAnchor, scroll: HTMLElement) {
  if (anchor.element.isConnected) return anchor.element;
  if (!anchor.blockId) return null;
  const block = Array.from(
    scroll.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
  ).find((element) => element.dataset.conversationBlockId === anchor.blockId);
  if (!block) return null;
  if (anchor.index < 0) return block;
  // Repeated openings are common in code-heavy replies, so prefer the match
  // nearest the old position. No match means no trustworthy measurement.
  let nearest: HTMLElement | null = null;
  let nearestGap = Infinity;
  readableChildren(block).forEach((child, index) => {
    const gap = Math.abs(index - anchor.index);
    if (gap < nearestGap && textKey(child) === anchor.key) {
      nearest = child;
      nearestGap = gap;
    }
  });
  return nearest;
}

/** How far the anchored content moved, re-binding it if it was re-rendered.
    Null once it can no longer be found: the caller must capture afresh rather
    than treat that as "did not move". */
export function readerAnchorDrift(
  anchor: ReaderAnchor,
  scroll: HTMLElement,
): number | null {
  const element = reattach(anchor, scroll);
  if (!element) return null;
  anchor.element = element;
  return topWithin(element, scroll) - anchor.top;
}
