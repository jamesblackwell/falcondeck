import type { ThinkingDisplay } from '@falcondeck/client-core'

/** Lines of the thought kept visible under `preview`. */
export const REASONING_PREVIEW_LINES = 3

export type ReasoningReveal = {
  /** Whether the thought starts expanded. */
  defaultOpen: boolean
  /** Lines shown while collapsed. Zero hides the body behind the header. */
  collapsedLines: number
}

/**
 * Map the shared `thinking_display` preference onto what the mobile transcript
 * can actually do.
 *
 * `auto` resolves to collapsed rather than Zed's follow-the-stream behaviour:
 * a reasoning item carries no running flag, so a row inside a virtualised list
 * cannot tell a thought that is still arriving from one that finished. The
 * live case is already covered by the thinking indicator under the transcript,
 * so collapsing here loses nothing and keeps row heights stable while blocks
 * stream in.
 */
export function resolveReasoningReveal(display: ThinkingDisplay): ReasoningReveal {
  switch (display) {
    case 'always_expanded':
      return { defaultOpen: true, collapsedLines: 0 }
    case 'preview':
      return { defaultOpen: false, collapsedLines: REASONING_PREVIEW_LINES }
    case 'always_collapsed':
    case 'auto':
      return { defaultOpen: false, collapsedLines: 0 }
  }
}

/**
 * Header text for a thought. Providers send a short summary for some thoughts
 * and nothing for others, and a multi-line summary would blow out the row, so
 * the header takes the first line only and falls back to a generic label.
 */
export function reasoningHeaderLabel(summary: string | null): string {
  const firstLine = (summary ?? '').split('\n').find((line) => line.trim().length > 0)
  return firstLine?.trim() ?? 'Thought process'
}
