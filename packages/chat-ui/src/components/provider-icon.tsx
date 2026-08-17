import { Terminal } from "lucide-react";

import { providerMark } from "@falcondeck/client-core";
import { cn } from "@falcondeck/ui";

type ProviderIconProps = {
  provider: string;
  className?: string;
  /**
   * When set, the SVG is labelled for icon-only use. Leave unset next to a
   * visible harness name so the mark stays decorative.
   */
  title?: string;
};

/**
 * Official vendor mark for a coding harness. Unknown ids fall back to a
 * terminal glyph. Always `currentColor` so theme tokens drive the fill.
 */
export function ProviderIcon({ provider, className, title }: ProviderIconProps) {
  const mark = providerMark(provider);
  const box = cn("h-3.5 w-3.5 shrink-0", className);

  if (!mark) {
    return (
      <Terminal
        aria-hidden={title ? undefined : true}
        aria-label={title}
        className={box}
      />
    );
  }

  return (
    <svg
      viewBox={mark.viewBox}
      fill="currentColor"
      fillRule={mark.fillRule}
      xmlns="http://www.w3.org/2000/svg"
      className={box}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {mark.paths.map((path) => (
        <path key={path.d} d={path.d} fillOpacity={path.opacity} />
      ))}
    </svg>
  );
}
