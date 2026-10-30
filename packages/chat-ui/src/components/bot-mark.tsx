import { workspaceColorCssVar, type BotIcon } from "@falcondeck/client-core";
import { cn } from "@falcondeck/ui";
import type { ReactNode } from "react";

/** Shapes drawn in a 16×16 box; a matching stroke softens the corners. */
const SHAPES: Record<string, ReactNode> = {
  circle: <circle cx="8" cy="8" r="6" />,
  diamond: <polygon points="8,1.6 14.4,8 8,14.4 1.6,8" />,
  square: <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2.4" />,
  triangle: <polygon points="8,2.1 14.24,12.9 1.76,12.9" />,
  hexagon: <polygon points="8,1.4 13.72,4.7 13.72,11.3 8,14.6 2.28,11.3 2.28,4.7" />,
  star: (
    <polygon points="8,1.6 9.76,6.17 14.66,6.44 10.85,9.53 12.11,14.26 8,11.6 3.89,14.26 5.15,9.53 1.34,6.44 6.24,6.17" />
  ),
  pentagon: <polygon points="8,1.9 14.28,6.46 11.88,13.84 4.12,13.84 1.72,6.46" />,
  cross: (
    <polygon points="6,1.8 10,1.8 10,6 14.2,6 14.2,10 10,10 10,14.2 6,14.2 6,10 1.8,10 1.8,6 6,6" />
  ),
};

/** A bot's colored shape. Activity is shown beside it, not on it. */
export function BotMark({
  icon,
  size = 14,
  className,
}: {
  icon: BotIcon;
  size?: number;
  className?: string;
}) {
  const color = workspaceColorCssVar(icon.color) ?? "currentColor";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill={color}
      stroke={color}
      strokeWidth={1.2}
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
    >
      {SHAPES[icon.shape] ?? SHAPES.circle}
    </svg>
  );
}
