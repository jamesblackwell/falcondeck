import * as Popover from "@radix-ui/react-popover";
import { ChevronUp, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  ComposerSuggestion,
  ComposerSuggestionOffer,
} from "@falcondeck/client-core";
import { cn } from "@falcondeck/ui";

export type ComposerSuggestionPillProps = {
  offer: ComposerSuggestionOffer | null;
  /** Submits the chosen action's prompt as the next turn. */
  onSubmit: (suggestion: ComposerSuggestion) => void;
  /** Hides the offer for the rest of this turn. Not persisted. */
  onDismiss: () => void;
};

/**
 * One compact pill of agent-offered next actions, sitting directly above the
 * composer.
 *
 * The pill is deliberately a single row with a split affordance: the wide
 * primary segment submits the recommended action in one click, and the chevron
 * opens the rest. Suggestions are an offer, never a prompt for input — the
 * composer stays fully usable behind them, and dismissing takes one click.
 *
 * Only the caller decides when an offer exists; this component does not know
 * about turn status. `deriveComposerSuggestions` already withholds offers
 * until the associated turn is idle.
 */
export function ComposerSuggestionPill({
  offer,
  onSubmit,
  onDismiss,
}: ComposerSuggestionPillProps) {
  const [open, setOpen] = useState(false);
  const openedForKey = useRef<string | null>(null);

  // A new offer replaces the old one outright, so an alternatives menu left
  // open would be showing actions that no longer exist.
  useEffect(() => {
    if (offer && openedForKey.current !== offer.key) {
      openedForKey.current = offer.key;
      setOpen(false);
    }
  }, [offer]);

  if (!offer) return null;
  const alternatives = offer.actions.slice(1);

  return (
    // Mirror the composer wrapper and its padding so the pill centers on the
    // prompt card's column at every responsive breakpoint. It sits tighter to
    // the composer than the goal bubble or queued-turns card: a single light
    // pill reads as attached to the input, not as another stacked block.
    <div className="mx-auto mb-1 w-full max-w-3xl px-3 md:px-6">
      <Popover.Root open={open} onOpenChange={setOpen}>
        {/* Anchor the alternatives on the whole pill rather than the chevron,
            so the menu reads as belonging to the offer, not to one control. */}
        <Popover.Anchor asChild>
          <div
            className="mx-auto flex w-fit max-w-full items-stretch overflow-hidden rounded-full border border-border-default bg-surface-2 shadow-[var(--fd-shadow-sm)]"
            role="group"
            aria-label="Suggested next steps"
          >
            <button
              type="button"
              onClick={() => onSubmit(offer.primary)}
              title={offer.primary.description ?? offer.primary.prompt}
              className="fd-focus flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-3 transition-colors hover:bg-surface-3"
            >
              <Sparkles
                className="h-3.5 w-3.5 shrink-0 text-accent"
                aria-hidden
              />
              <span className="truncate text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
                {offer.primary.label}
              </span>
            </button>

            {alternatives.length > 0 ? (
              <>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    aria-label={`Show ${alternatives.length} more suggestion${alternatives.length === 1 ? "" : "s"}`}
                    className={cn(
                      "fd-focus flex items-center border-l border-border-subtle px-1.5 transition-colors hover:bg-surface-3",
                      open && "bg-surface-3",
                    )}
                  >
                    <ChevronUp
                      className={cn(
                        "h-3.5 w-3.5 text-fg-muted transition-transform",
                        open && "rotate-180",
                      )}
                      aria-hidden
                    />
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    align="center"
                    side="top"
                    sideOffset={8}
                    className="z-50 w-80 max-w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
                  >
                    <ul className="flex flex-col">
                      {alternatives.map((suggestion) => (
                        <li key={suggestion.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setOpen(false);
                              onSubmit(suggestion);
                            }}
                            className="fd-focus flex w-full flex-col items-start gap-0.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2"
                          >
                            <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                              {suggestion.label}
                            </span>
                            {suggestion.description ? (
                              <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                                {suggestion.description}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Popover.Content>
                </Popover.Portal>
              </>
            ) : null}

            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss suggestions"
              className="fd-focus flex items-center border-l border-border-subtle px-1.5 text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </Popover.Anchor>
      </Popover.Root>
    </div>
  );
}
