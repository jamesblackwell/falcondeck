import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@falcondeck/ui";

const BAR_WIDTH = 3;
const BAR_GAP = 3;
const DOT_HEIGHT = 4;
const MAX_BAR_HEIGHT = 26;

/**
 * Scrolling loudness history for an in-composer recording session. Bars fill
 * from the left as levels arrive; unfilled slots read as faint dots, and once
 * the strip is full the oldest samples scroll off, iOS-voice-memo style.
 */
export function VoiceWaveform({
  levels,
  muted = false,
  className,
}: {
  /** Loudness samples in [0, 1], oldest first. */
  levels: readonly number[];
  /** Dims the strip while the recording is being transcribed. */
  muted?: boolean;
  className?: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [slotCount, setSlotCount] = useState(0);

  useLayoutEffect(() => {
    const element = stripRef.current;
    if (!element) return;
    const update = () => {
      setSlotCount(
        Math.max(
          0,
          Math.floor((element.clientWidth + BAR_GAP) / (BAR_WIDTH + BAR_GAP)),
        ),
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const visible = levels.slice(-slotCount);

  return (
    <div
      ref={stripRef}
      aria-hidden="true"
      className={cn(
        "flex h-8 min-w-0 flex-1 items-center overflow-hidden",
        muted && "opacity-40",
        className,
      )}
      style={{ gap: BAR_GAP }}
    >
      {Array.from({ length: slotCount }, (_, index) => {
        const level = visible[index];
        const filled = level !== undefined;
        return (
          <span
            key={index}
            className={cn(
              "shrink-0 rounded-full",
              filled ? "bg-fg-muted" : "bg-fg-faint",
            )}
            style={{
              width: BAR_WIDTH,
              height: filled
                ? DOT_HEIGHT + level * (MAX_BAR_HEIGHT - DOT_HEIGHT)
                : DOT_HEIGHT,
            }}
          />
        );
      })}
    </div>
  );
}

export function formatVoiceDuration(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
