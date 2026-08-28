/** Fence tags that should render as a diagram instead of a code listing. */
const MERMAID_LANGUAGES = new Set(["mermaid", "mmd"]);

export function isMermaidLanguage(
  language: string | null | undefined,
): boolean {
  if (!language) return false;
  return MERMAID_LANGUAGES.has(language.trim().toLowerCase());
}

/** Reads a `language-*` fence tag out of a react-markdown/hast className. */
export function fenceLanguageFromClassName(
  className: unknown,
): string | null {
  const value = Array.isArray(className)
    ? className.filter((item): item is string => typeof item === "string").join(" ")
    : typeof className === "string"
      ? className
      : "";
  const match = /(?:^|\s)language-(\w+)/.exec(value);
  return match?.[1] ?? null;
}

export type MermaidPalette = {
  darkMode: boolean;
  fontFamily: string;
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceHighest: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderSubtle: string;
  accent: string;
  danger: string;
  cat: readonly string[];
};

function put(
  target: Record<string, string | boolean>,
  key: string,
  value: string | undefined,
) {
  if (value) target[key] = value;
}

/**
 * Maps FalconDeck surface tokens onto mermaid's `base` theme. Empty strings
 * are omitted so a client that could not resolve a token still gets mermaid's
 * own fallback instead of an invalid color.
 */
export function mermaidThemeVariables(
  palette: MermaidPalette,
): Record<string, string | boolean> {
  const variables: Record<string, string | boolean> = {
    darkMode: palette.darkMode,
  };
  put(variables, "fontFamily", palette.fontFamily);
  put(variables, "background", palette.background);
  put(variables, "mainBkg", palette.surface);
  put(variables, "primaryColor", palette.surfaceRaised);
  put(variables, "primaryTextColor", palette.text);
  put(variables, "primaryBorderColor", palette.border);
  put(variables, "secondaryColor", palette.surface);
  put(variables, "secondaryTextColor", palette.textSecondary);
  put(variables, "secondaryBorderColor", palette.borderSubtle);
  put(variables, "tertiaryColor", palette.surfaceHighest);
  put(variables, "tertiaryTextColor", palette.textMuted);
  put(variables, "tertiaryBorderColor", palette.borderSubtle);
  put(variables, "lineColor", palette.textMuted);
  put(variables, "textColor", palette.text);
  put(variables, "nodeBorder", palette.border);
  put(variables, "clusterBkg", palette.surface);
  put(variables, "clusterBorder", palette.borderSubtle);
  put(variables, "titleColor", palette.text);
  put(variables, "edgeLabelBackground", palette.background);
  put(variables, "actorBkg", palette.surfaceRaised);
  put(variables, "actorBorder", palette.border);
  put(variables, "actorTextColor", palette.text);
  put(variables, "actorLineColor", palette.textMuted);
  put(variables, "signalColor", palette.textSecondary);
  put(variables, "signalTextColor", palette.text);
  put(variables, "labelBoxBkgColor", palette.surfaceRaised);
  put(variables, "labelBoxBorderColor", palette.border);
  put(variables, "labelTextColor", palette.text);
  put(variables, "loopTextColor", palette.text);
  put(variables, "noteBkgColor", palette.surfaceRaised);
  put(variables, "noteTextColor", palette.text);
  put(variables, "noteBorderColor", palette.border);
  put(variables, "activationBkgColor", palette.surfaceHighest);
  put(variables, "sequenceNumberColor", palette.text);
  put(variables, "sectionBkgColor", palette.surfaceRaised);
  put(variables, "altSectionBkgColor", palette.surface);
  put(variables, "gridColor", palette.borderSubtle);
  put(variables, "errorBkgColor", palette.surfaceRaised);
  put(variables, "errorTextColor", palette.danger);
  put(variables, "pieTitleTextColor", palette.text);
  put(variables, "pieLegendTextColor", palette.textSecondary);

  palette.cat.forEach((color, index) => {
    put(variables, `cScale${index}`, color);
    put(variables, `pie${index + 1}`, color);
  });

  return variables;
}

export type MermaidRenderOptions = {
  startOnLoad: false;
  securityLevel: "strict";
  theme: "base";
  look: "classic";
  htmlLabels: false;
  logLevel: "fatal";
  suppressErrorRendering: true;
  fontFamily?: string;
  themeVariables: Record<string, string | boolean>;
  flowchart: { htmlLabels: false; useMaxWidth: true; padding: number };
  sequence: { useMaxWidth: true };
  maxTextSize: number;
};

export function mermaidRenderOptions(
  palette: MermaidPalette,
): MermaidRenderOptions {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    look: "classic",
    htmlLabels: false,
    logLevel: "fatal",
    suppressErrorRendering: true,
    fontFamily: palette.fontFamily || undefined,
    themeVariables: mermaidThemeVariables(palette),
    flowchart: { htmlLabels: false, useMaxWidth: true, padding: 12 },
    sequence: { useMaxWidth: true },
    maxTextSize: 50_000,
  };
}
