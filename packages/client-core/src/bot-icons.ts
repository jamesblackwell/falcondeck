import { WORKSPACE_COLOR_IDS } from "./workspace-colors";

/** Shapes a bot mark can take, in the daemon's assignment order. */
export const BOT_ICON_SHAPES = [
  "circle",
  "diamond",
  "square",
  "triangle",
  "hexagon",
  "star",
  "pentagon",
  "cross",
] as const;

export type BotIconShape = (typeof BOT_ICON_SHAPES)[number];

/** Categorical theme tokens, in the daemon's assignment order. */
export const BOT_ICON_COLORS = WORKSPACE_COLOR_IDS;

/** A small colored shape identifying a bot. `color` is a `cat-N` token. */
export type BotIcon = { shape: string; color: string };

const SHAPES = new Set<string>(BOT_ICON_SHAPES);
const COLORS = new Set<string>(BOT_ICON_COLORS);

export function isBotIcon(icon: BotIcon | null | undefined): icon is BotIcon {
  return Boolean(icon && SHAPES.has(icon.shape) && COLORS.has(icon.color));
}

/**
 * Each bot's mark. Mirrors the daemon, which fills missing marks with the
 * next unused shape and color in order the next time any bot is saved.
 */
export function resolveBotIcons(
  bots: ReadonlyArray<{ id: string; icon?: BotIcon | null }>,
): Map<string, BotIcon> {
  const resolved = new Map<string, BotIcon>();
  const taken: BotIcon[] = bots.flatMap((bot) => (isBotIcon(bot.icon) ? [bot.icon] : []));
  for (const bot of bots) {
    if (isBotIcon(bot.icon)) {
      resolved.set(bot.id, bot.icon);
      continue;
    }
    const pick = (options: readonly string[], part: keyof BotIcon) =>
      options.find((option) => !taken.some((icon) => icon[part] === option)) ??
      options[taken.length % options.length];
    const icon = { shape: pick(BOT_ICON_SHAPES, "shape"), color: pick(BOT_ICON_COLORS, "color") };
    taken.push(icon);
    resolved.set(bot.id, icon);
  }
  return resolved;
}
