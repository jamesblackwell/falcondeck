/** One line of text, and the height of an empty composer editor. */
export const COMPOSER_EDITOR_MIN_HEIGHT = 52;
/** Auto-grow ceiling: three times the original 200px cap. */
export const COMPOSER_EDITOR_MAX_HEIGHT = 600;

/** The whole composer stays within this share of the conversation pane. */
const PANE_SHARE = 0.6;
/** The expanded editor rests at about half the pane. */
const EXPANDED_SHARE = 0.5;
/** Docked bars can take the rest of the pane; the transcript keeps this much. */
const MIN_TRANSCRIPT_HEIGHT = 120;
/** One row of attachment previews stays visible, however short the window. */
const MIN_EXTRAS_HEIGHT = 80;

/**
 * Measured layout, in px. Each value is stable while the editor resizes, so
 * the limits never feed back on themselves. Zero means not measured.
 */
export type ComposerMetrics = {
  /** The conversation column. */
  paneHeight: number;
  /** Transcript plus composer: what the composer could take from the transcript. */
  roomHeight: number;
  /** The composer minus its editor and attachment strips. */
  chromeHeight: number;
  /** Natural height of the attachment and quote strips. */
  extrasHeight: number;
  /** Distance from the top of the pane to the top of the editor. */
  spaceAbove: number;
};

export const UNMEASURED_COMPOSER: ComposerMetrics = {
  paneHeight: 0,
  roomHeight: 0,
  chromeHeight: 0,
  extrasHeight: 0,
  spaceAbove: 0,
};

export type ComposerHeightLimits = {
  editorMin: number;
  editorMax: number;
  /** Attachment and quote strips scroll past this height. */
  extrasMax: number | undefined;
};

export function composerHeightLimits(
  expanded: boolean,
  metrics: ComposerMetrics,
): ComposerHeightLimits {
  const floor = COMPOSER_EDITOR_MIN_HEIGHT;
  const { paneHeight, roomHeight, chromeHeight, extrasHeight } = metrics;
  if (paneHeight <= 0) {
    return {
      editorMin: expanded ? COMPOSER_EDITOR_MAX_HEIGHT : floor,
      editorMax: COMPOSER_EDITOR_MAX_HEIGHT,
      extrasMax: undefined,
    };
  }

  const composerBudget = Math.min(
    paneHeight * PANE_SHARE,
    roomHeight > 0 ? roomHeight - MIN_TRANSCRIPT_HEIGHT : Infinity,
  );
  const budget = Math.max(0, composerBudget - chromeHeight);
  // Attachments give way before the editor does: they scroll past half.
  const extrasMax = Math.floor(Math.max(MIN_EXTRAS_HEIGHT, budget / 2));
  const editorBudget = Math.floor(
    Math.max(floor, budget - Math.min(extrasHeight, extrasMax)),
  );

  if (!expanded) {
    return {
      editorMin: floor,
      editorMax: Math.min(COMPOSER_EDITOR_MAX_HEIGHT, editorBudget),
      extrasMax,
    };
  }
  const resting = Math.floor(Math.max(floor, paneHeight * EXPANDED_SHARE));
  return {
    editorMin: Math.min(editorBudget, resting),
    editorMax: editorBudget,
    extrasMax,
  };
}
