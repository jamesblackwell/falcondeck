import { BookOpen, Orbit, Target, type LucideIcon } from "lucide-react";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { RankedSlashItem, SlashMatchSpan } from "@falcondeck/client-core";
import { slashSkillSourceLabel } from "@falcondeck/client-core";
import { Kbd, MenuHeader, cn } from "@falcondeck/ui";

const NATIVE_ICON: Record<"goal" | "mission" | "compact", LucideIcon> = {
  goal: Target,
  mission: Orbit,
  compact: BookOpen,
};

const NATIVE_BADGE: Partial<Record<"goal" | "mission" | "compact", string>> = {
  mission: "FalconDeck",
  compact: "Harness",
};

export type SlashCommandMenuProps = {
  query: string;
  items: readonly RankedSlashItem[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (item: RankedSlashItem) => void;
  listId: string;
};

/**
 * Composer slash menu. The textarea keeps focus; this is a listbox the
 * composer drives with arrows, Tab, and Enter. Ranking lives in client-core
 * so a prefix like `/fresh` cannot lose to a description that says "refresh".
 */
export function SlashCommandMenu({
  query,
  items,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  listId,
}: SlashCommandMenuProps) {
  const pointerArmedRef = useRef(false);
  const itemIds = items.map((item) => item.id).join("\0");

  useEffect(() => {
    pointerArmedRef.current = false;
  }, [query, itemIds]);

  const activeId = items[activeIndex]?.id;
  useLayoutEffect(() => {
    if (!activeId) return;
    document
      .getElementById(`${listId}-${activeId}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, listId]);

  const headerLabel =
    query && items.length > 0
      ? items.length === 1
        ? "1 match"
        : `${items.length} matches`
      : "Commands";

  return (
    <div
      data-side="top"
      data-state="open"
      className="fd-menu-pop absolute right-3 bottom-full left-3 z-40 mb-2 overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 shadow-[var(--fd-shadow-lg)]"
    >
      {items.length === 0 ? (
        <p className="px-3 py-3 text-[length:var(--fd-text-sm)] text-fg-muted">
          {query ? (
            <>
              No commands or skills match{" "}
              <span className="font-medium text-fg-secondary">/{query}</span>
            </>
          ) : (
            "No commands or skills yet"
          )}
        </p>
      ) : (
        <>
          <MenuHeader
            label={headerLabel}
            aria-hidden="true"
            className="px-3 pt-2 pb-1"
          />
          <div
            id={listId}
            role="listbox"
            aria-label="Commands and skills"
            onPointerMove={() => {
              pointerArmedRef.current = true;
            }}
            className="max-h-72 overflow-y-auto overscroll-contain p-1"
          >
            {items.map((item, index) => {
              const active = index === activeIndex;
              const previous = items[index - 1];
              const showGroupRule =
                !query &&
                previous?.kind === "native" &&
                item.kind === "skill";
              return (
                <Fragment key={item.id}>
                  {showGroupRule ? (
                    <div
                      role="presentation"
                      className="mx-2 my-1 border-t border-border-subtle"
                    />
                  ) : null}
                  <SlashCommandRow
                    item={item}
                    query={query}
                    active={active}
                    optionId={`${listId}-${item.id}`}
                    onPointerEnter={() => {
                      if (pointerArmedRef.current) onActiveIndexChange(index);
                    }}
                    onSelect={() => onSelect(item)}
                  />
                </Fragment>
              );
            })}
          </div>
          <div className="flex items-center gap-3 border-t border-border-subtle px-3 py-1.5 text-[length:var(--fd-text-2xs)] text-fg-muted">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span>navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <Kbd>tab</Kbd>
              <Kbd>↵</Kbd>
              <span>select</span>
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd>esc</Kbd>
              <span>close</span>
            </span>
          </div>
        </>
      )}
      {items.length > 0 ? (
        <span className="sr-only" role="status" aria-live="polite">
          {items.length === 1 ? "1 match" : `${items.length} matches`}
        </span>
      ) : null}
    </div>
  );
}

function SlashCommandRow({
  item,
  query,
  active,
  optionId,
  onPointerEnter,
  onSelect,
}: {
  item: RankedSlashItem;
  query: string;
  active: boolean;
  optionId: string;
  onPointerEnter: () => void;
  onSelect: () => void;
}) {
  const title = slashItemTitle(item);
  const description = slashItemDescription(item);
  const badge = slashItemBadge(item);
  const titleMatch =
    query &&
    item.match &&
    (item.match.field === "alias" ||
      (item.match.field === "label" && title === slashItemLabel(item)))
      ? item.match
      : null;
  const descriptionMatch =
    query && item.match?.field === "description" ? item.match : null;

  return (
    <button
      id={optionId}
      type="button"
      role="option"
      aria-selected={active}
      data-highlighted={active ? "true" : undefined}
      onMouseDown={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        onSelect();
      }}
      onPointerEnter={onPointerEnter}
      className={cn(
        "relative flex w-full items-start gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left transition-colors duration-[var(--fd-duration-hover)]",
        active ? "bg-interactive-selected" : "bg-transparent",
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute top-1.5 bottom-1.5 left-0.5 w-0.5 rounded-full bg-accent"
        />
      ) : null}
      <SlashRowIcon item={item} active={active} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "min-w-0 truncate font-medium text-[length:var(--fd-text-sm)]",
              query && titleMatch ? "text-fg-tertiary" : "text-fg-primary",
            )}
          >
            <HighlightedText text={title} match={titleMatch} />
          </span>
          {badge ? (
            <span className="fd-microlabel shrink-0 rounded-full border border-border-subtle px-1.5 py-px text-fg-muted">
              {badge}
            </span>
          ) : null}
        </span>
        {description ? (
          <span
            className={cn(
              "mt-0.5 block truncate text-[length:var(--fd-text-xs)]",
              descriptionMatch ? "text-fg-muted" : "text-fg-secondary",
            )}
          >
            <HighlightedText text={description} match={descriptionMatch} />
          </span>
        ) : null}
      </span>
    </button>
  );
}

function SlashRowIcon({
  item,
  active,
}: {
  item: RankedSlashItem;
  active: boolean;
}) {
  if (item.kind === "native") {
    const Icon = NATIVE_ICON[item.command.id];
    return (
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)]",
          active
            ? "bg-accent-muted text-accent"
            : "bg-surface-3 text-fg-muted",
        )}
      >
        <Icon className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)] font-mono text-[length:var(--fd-text-xs)] leading-none",
        active ? "bg-accent-muted text-accent" : "bg-surface-3 text-fg-muted",
      )}
    >
      /
    </span>
  );
}

function HighlightedText({
  text,
  match,
}: {
  text: string;
  match: SlashMatchSpan | null;
}): ReactNode {
  if (!match || match.length <= 0 || match.start >= text.length) return text;
  const start = Math.max(0, match.start);
  const end = Math.min(text.length, start + match.length);
  if (end <= start) return text;
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-transparent font-semibold text-fg-primary">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

function slashItemTitle(item: RankedSlashItem): string {
  if (item.kind === "native") {
    return item.command.id === "goal" ? item.command.label : item.command.alias;
  }
  return item.skill.alias;
}

function slashItemLabel(item: RankedSlashItem): string {
  return item.kind === "native" ? item.command.label : item.skill.label;
}

function slashItemDescription(item: RankedSlashItem): string | null {
  if (item.kind === "native") return item.command.description;
  return item.skill.description ?? item.skill.label;
}

function slashItemBadge(item: RankedSlashItem): string | null {
  if (item.kind === "native") return NATIVE_BADGE[item.command.id] ?? null;
  return slashSkillSourceLabel(item.skill.source_kind);
}
