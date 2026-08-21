import { type MermaidPalette } from "@falcondeck/client-core";

type ThemeColors = {
  isDark?: boolean;
  colors: {
    surface: { 1: string; 2: string; 3: string; 4: string };
    fg: { primary: string; secondary: string; muted: string };
    border: { default: string; subtle: string };
    accent: { default: string };
    danger: { default: string };
    cat?: Record<number, string> | readonly string[];
  };
  fontFamily: { sans: string };
};

export function mermaidPaletteFromTheme(theme: ThemeColors): MermaidPalette {
  const catSource = theme.colors.cat;
  const cat = Array.isArray(catSource)
    ? [...catSource]
    : Array.from({ length: 12 }, (_, index) =>
        catSource ? String(catSource[index + 1] ?? "") : "",
      );
  return {
    darkMode: theme.isDark !== false,
    fontFamily: theme.fontFamily.sans,
    background: theme.colors.surface[1],
    surface: theme.colors.surface[2],
    surfaceRaised: theme.colors.surface[3],
    surfaceHighest: theme.colors.surface[4],
    text: theme.colors.fg.primary,
    textSecondary: theme.colors.fg.secondary,
    textMuted: theme.colors.fg.muted,
    border: theme.colors.border.default,
    borderSubtle: theme.colors.border.subtle,
    accent: theme.colors.accent.default,
    danger: theme.colors.danger.default,
    cat,
  };
}
