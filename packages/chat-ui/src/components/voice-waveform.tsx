import type { CSSProperties } from "react";

import { cn } from "@falcondeck/ui";

const VOICE_BAR_COUNT = 36;

function barStyle(index: number): CSSProperties {
  const duration = 0.8 + ((index * 37) % 9) / 12;
  const delay = -(((index * 53) % 100) / 100) * duration;
  return {
    animationDuration: `${duration.toFixed(2)}s`,
    animationDelay: `${delay.toFixed(2)}s`,
  };
}

export function VoiceWaveform({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-8 items-center justify-center gap-[3px] overflow-hidden",
        className,
      )}
    >
      {Array.from({ length: VOICE_BAR_COUNT }, (_, index) => (
        <span
          key={index}
          className="fd-voice-bar h-full w-0.5 shrink-0 rounded-full bg-fg-muted"
          style={barStyle(index)}
        />
      ))}
    </div>
  );
}

export function formatVoiceDuration(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
