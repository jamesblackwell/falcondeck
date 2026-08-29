import type { ExtensionSnapshot, ExtensionView, ThreadStatus } from './types'

export const FOLLOW_UP_SUGGESTIONS_EXTENSION_ID = 'falcondeck.follow-up-suggestions'

/** Bounds the daemon enforces before a set reaches any client. */
export const MAX_COMPOSER_SUGGESTIONS = 5
export const MAX_COMPOSER_SUGGESTION_LABEL_CHARS = 30
export const MAX_COMPOSER_SUGGESTION_DESCRIPTION_CHARS = 120
export const MAX_COMPOSER_SUGGESTION_PROMPT_CHARS = 512

export type ComposerSuggestion = {
  id: string
  label: string
  description?: string
  prompt: string
}

/** The offers to render for one thread, primary action first. */
export type ComposerSuggestionOffer = {
  /** Extension that published the offers, for attribution and dismissal. */
  extensionId: string
  /** The action shown in the pill's primary segment. */
  primary: ComposerSuggestion
  /** Every offered action, primary first. */
  actions: ComposerSuggestion[]
  /** Stable key that changes whenever the offered set changes. */
  key: string
}

function isSuggestion(value: unknown): value is ComposerSuggestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const action = value as Partial<ComposerSuggestion>
  return (
    typeof action.id === 'string' &&
    action.id.trim().length > 0 &&
    typeof action.label === 'string' &&
    action.label.trim().length > 0 &&
    typeof action.prompt === 'string' &&
    action.prompt.trim().length > 0
  )
}

function truncate(value: string, limit: number): string {
  const characters = Array.from(value)
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : value
}

function truncateWithoutMarker(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('')
}

/**
 * Re-applies the daemon's bounds on the client. The daemon already rejects
 * malformed sets, so this is defence against an older or misbehaving peer
 * rather than the primary contract — a set that survives here always renders.
 */
function normalizeSuggestion(action: ComposerSuggestion): ComposerSuggestion {
  const description = action.description?.trim()
  return {
    id: action.id.trim(),
    label: truncate(action.label.trim(), MAX_COMPOSER_SUGGESTION_LABEL_CHARS),
    prompt: truncateWithoutMarker(
      action.prompt.trim(),
      MAX_COMPOSER_SUGGESTION_PROMPT_CHARS,
    ),
    ...(description
      ? {
          description: truncate(
            description.replace(/\s+/g, ' '),
            MAX_COMPOSER_SUGGESTION_DESCRIPTION_CHARS,
          ),
        }
      : {}),
  }
}

function suggestionViews(
  extensions: ExtensionSnapshot | null | undefined,
  threadId: string,
): ExtensionView[] {
  const enabled = new Map(
    (extensions?.catalog ?? [])
      .filter(extension => extension.enabled)
      .map(extension => [
        extension.id,
        new Set(
          (extension.contributes.composerSuggestions ?? []).map(
            contribution => contribution.view,
          ),
        ),
      ]),
  )
  return (extensions?.views ?? []).filter(view => {
    if (view.scope?.kind !== 'thread' || view.scope.id !== threadId) return false
    return enabled.get(view.extension_id)?.has(view.view_id) ?? false
  })
}

/**
 * Derives the single offer to render above one thread's composer.
 *
 * Offers are only shown once the associated turn has gone idle: while an agent
 * is running or waiting on the user, the composer already belongs to that turn
 * and a suggestion pill would compete with it. An errored thread is excluded
 * too — those offers were derived from work that did not finish. Only one
 * extension's offers are
 * rendered — the alphabetically first, so the choice is stable rather than
 * dependent on projection arrival order.
 */
export function deriveComposerSuggestions(
  extensions: ExtensionSnapshot | null | undefined,
  threadId: string | null | undefined,
  threadStatus: ThreadStatus | null | undefined,
): ComposerSuggestionOffer | null {
  if (!threadId || threadStatus !== 'idle') return null

  const views = suggestionViews(extensions, threadId).sort((left, right) =>
    left.extension_id.localeCompare(right.extension_id),
  )
  for (const view of views) {
    const value =
      view.value && typeof view.value === 'object' && !Array.isArray(view.value)
        ? (view.value as Record<string, unknown>)
        : {}
    const rawActions = Array.isArray(value.actions) ? value.actions : []
    const actions = rawActions
      .filter(isSuggestion)
      .slice(0, MAX_COMPOSER_SUGGESTIONS)
      .map(normalizeSuggestion)
    if (actions.length === 0) continue

    const preferredId =
      typeof value.preferredActionId === 'string' ? value.preferredActionId.trim() : ''
    const preferredIndex = actions.findIndex(action => action.id === preferredId)
    const ordered =
      preferredIndex > 0
        ? [actions[preferredIndex], ...actions.filter((_, index) => index !== preferredIndex)]
        : actions

    return {
      extensionId: view.extension_id,
      primary: ordered[0],
      actions: ordered,
      key: `${view.extension_id}:${view.updated_at}:${ordered.map(action => action.id).join(',')}`,
    }
  }
  return null
}
