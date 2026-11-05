import { useEffect, useRef, useState } from "react";

// Twenty paints per second bounds Markdown work without the large jumps of
// a 120ms batch. This only coalesces received text; it never invents tokens.
const STREAMING_TEXT_INTERVAL_MS = 50;
// The paced reveal drains the backlog over this long, so painted text never
// trails the wire by much more, and never crawls below the floor rate. Same
// numbers as the native client's StreamingText.
const PACED_DRAIN_SECONDS = 0.18;
const PACED_MIN_CHARS_PER_SECOND = 45;
// Animation frames stop in a hidden or occluded webview; text must not.
const PACED_FRAME_FALLBACK_MS = 120;

export type StreamingTextOptions = {
  /** Spread each network burst across display frames instead of painting it
      whole. Costs one Markdown tail parse per frame, so opt in per client. */
  paced?: boolean;
};

/** Length to show after `elapsedMs`, given `shown` of `target` characters. */
export function nextRevealLength(
  text: string,
  shown: number,
  elapsedMs: number,
): number {
  const backlog = text.length - shown;
  if (backlog <= 0) return text.length;
  const rate = Math.max(backlog / PACED_DRAIN_SECONDS, PACED_MIN_CHARS_PER_SECOND);
  let next = Math.min(
    text.length,
    shown + Math.max(1, Math.round((rate * elapsedMs) / 1000)),
  );
  // Never stop between the two halves of a surrogate pair.
  const unit = text.charCodeAt(next - 1);
  if (next < text.length && unit >= 0xd800 && unit <= 0xdbff) next += 1;
  return next;
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useStreamingText(
  text: string,
  streaming: boolean,
  options?: StreamingTextOptions,
): string {
  const paced =
    options?.paced === true &&
    typeof requestAnimationFrame === "function" &&
    !prefersReducedMotion();
  const [displayed, setDisplayed] = useState(text);
  const lastPaintAt = useRef(Date.now());
  // Recycled rows, replacements, and completed messages must not show the
  // previous value while waiting for a timer (or even for an effect).
  const immediate = !streaming || !text.startsWith(displayed);

  useEffect(() => {
    if (text === displayed) return;
    const publish = (next: string) => {
      lastPaintAt.current = Date.now();
      setDisplayed(next);
    };
    if (immediate) {
      publish(text);
      return;
    }
    if (paced) {
      const step = () => {
        const elapsed = Date.now() - lastPaintAt.current;
        publish(
          text.slice(0, nextRevealLength(text, displayed.length, elapsed)),
        );
      };
      const frame = requestAnimationFrame(step);
      // Measured from the last paint, so a steady stream of chunks resetting
      // this effect cannot postpone it for as long as frames are stopped.
      const fallback = setTimeout(
        () => publish(text),
        Math.max(
          0,
          PACED_FRAME_FALLBACK_MS - (Date.now() - lastPaintAt.current),
        ),
      );
      return () => {
        cancelAnimationFrame(frame);
        clearTimeout(fallback);
      };
    }
    const remaining =
      STREAMING_TEXT_INTERVAL_MS - (Date.now() - lastPaintAt.current);
    if (remaining <= 0) {
      publish(text);
      return;
    }
    // Keep the original deadline as new chunks arrive: continuous traffic
    // must not postpone the trailing update indefinitely.
    const timer = setTimeout(() => publish(text), remaining);
    return () => clearTimeout(timer);
  }, [displayed, immediate, paced, text]);

  return immediate ? text : displayed;
}
