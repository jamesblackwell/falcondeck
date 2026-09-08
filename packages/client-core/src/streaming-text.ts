import { useEffect, useRef, useState } from "react";

// Twenty paints per second bounds Markdown work without the large jumps of
// a 120ms batch. This only coalesces received text; it never invents tokens.
const STREAMING_TEXT_INTERVAL_MS = 50;

export function useStreamingText(text: string, streaming: boolean): string {
  const [displayed, setDisplayed] = useState(text);
  const lastPaintAt = useRef(Date.now());
  // Recycled rows, replacements, and completed messages must not show the
  // previous value while waiting for a timer (or even for an effect).
  const immediate = !streaming || !text.startsWith(displayed);

  useEffect(() => {
    if (text === displayed) return;
    const remaining = STREAMING_TEXT_INTERVAL_MS - (Date.now() - lastPaintAt.current);
    const publish = () => {
      lastPaintAt.current = Date.now();
      setDisplayed(text);
    };
    if (immediate || remaining <= 0) {
      publish();
      return;
    }
    // Keep the original deadline as new chunks arrive: continuous traffic
    // must not postpone the trailing update indefinitely.
    const timer = setTimeout(publish, remaining);
    return () => clearTimeout(timer);
  }, [displayed, immediate, text]);

  return immediate ? text : displayed;
}
