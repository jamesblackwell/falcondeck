import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";

type StatusTextSwapProps = {
  text: string;
  /**
   * Held live state (thinking, sending, transcribing). Adds a quiet shimmer
   * until the next label arrives. Settled copy should leave this off.
   */
  live?: boolean;
  className?: string;
};

/** Matches `--fd-duration-normal`. Outgoing copy unmounts after this, even if
    `animationend` never fires (jsdom). */
const STATUS_TEXT_SWAP_MS = 150;

function prefersReducedMotion() {
  // jsdom has no matchMedia. Treat a missing motion API as "no animation"
  // so tests and non-browser renders swap text in place.
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * One status slot: the current label is always the accessible text, and a
 * change slides the old copy up while the new copy enters from below.
 * Transform and opacity only — no blur — so a busy transcript stays on the
 * compositor. First paint of a slot does not animate.
 */
export function StatusTextSwap({
  text,
  live = false,
  className,
}: StatusTextSwapProps) {
  const previousTextRef = useRef(text);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const reduceMotion = prefersReducedMotion();

  useLayoutEffect(() => {
    if (text === previousTextRef.current) return;
    const previous = previousTextRef.current;
    previousTextRef.current = text;
    if (prefersReducedMotion()) {
      setOutgoing(null);
      return;
    }
    // Keep the first exiting label if a second swap arrives mid-animation;
    // only the incoming copy retargets.
    setOutgoing((current) => current ?? previous);
  }, [text]);

  useEffect(() => {
    if (!outgoing) return;
    const timeout = window.setTimeout(
      () => setOutgoing(null),
      STATUS_TEXT_SWAP_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [outgoing]);

  const shimmer = live && !reduceMotion && !outgoing;

  return (
    <span
      className={cn(
        "fd-status-text",
        shimmer && "fd-status-text--live",
        className,
      )}
    >
      {outgoing ? (
        <span
          aria-hidden="true"
          className="fd-status-text__out"
          data-text={outgoing}
        />
      ) : null}
      <span
        className={cn(
          "fd-status-text__in",
          outgoing && "fd-status-text__in--enter",
        )}
      >
        {text}
      </span>
    </span>
  );
}
