import * as React from "react";
import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AlertTriangle, Check, ListFilter } from "lucide-react";

import type {
  ExtensionSidebarFilterDefinition,
  ExtensionUiSelectOption,
} from "@falcondeck/client-core";
import { cn } from "@falcondeck/ui";

import { EXTENSION_SWATCH_CLASSES } from "./extension-ui-renderer";

const EMPTY_SELECTION = new Set<string>();

function FilterOptionLabel({ option }: { option: ExtensionUiSelectOption }) {
  return (
    <>
      {option.tone ? (
        <span
          aria-hidden="true"
          className={cn(
            "h-2.5 w-2.5 shrink-0 rounded-[var(--fd-radius-full)]",
            EXTENSION_SWATCH_CLASSES[option.tone],
          )}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
    </>
  );
}

const ExtensionSidebarFilterMenu = memo(function ExtensionSidebarFilterMenu({
  definition,
  selected,
  onChange,
}: {
  definition: ExtensionSidebarFilterDefinition;
  selected: ReadonlySet<string>;
  onChange: (key: string, selected: ReadonlySet<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const node =
    definition.document?.root.type === "select"
      ? definition.document.root
      : null;
  const active = selected.size > 0;
  const label = node?.label ?? definition.title;

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]',
      ),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const toggle = (value: string) => {
    if (!node) return;
    const next = new Set(node.multiple ? selected : []);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(definition.key, next);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={
            definition.unsupportedReason ??
            (active ? `${label} (${selected.size} active)` : label)
          }
          aria-label={
            definition.unsupportedReason
              ? `${label}: unsupported extension filter`
              : label
          }
          className={cn(
            "fd-focus relative -my-0.5 shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary",
            open || active ? "bg-surface-3 text-fg-secondary" : "text-fg-muted",
            definition.unsupportedReason ? "text-warning" : null,
          )}
        >
          {definition.unsupportedReason ? (
            <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <ListFilter aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {active ? (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-[var(--fd-radius-full)] bg-accent"
            />
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 w-56 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
        >
          {node ? (
            <div role="menu" aria-label={label} onKeyDown={handleMenuKeyDown}>
              <div className="mx-1 mb-1 flex min-h-9 items-center justify-between gap-3 border-b border-border-subtle px-1.5 py-1">
                <p className="min-w-0 truncate text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
                  {label}
                </p>
                {active ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => onChange(definition.key, new Set())}
                    className="fd-focus-fill shrink-0 rounded-[var(--fd-radius-sm)] px-1.5 py-1 text-[length:var(--fd-text-xs)] text-fg-muted hover:bg-surface-3 hover:text-fg-secondary focus-visible:bg-surface-3 focus-visible:text-fg-secondary"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              {node.options.map((option) => {
                const checked = selected.has(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    role={node.multiple ? "menuitemcheckbox" : "menuitemradio"}
                    aria-checked={checked}
                    onClick={() => toggle(option.value)}
                    className="fd-focus-fill flex h-8 w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3 focus-visible:bg-surface-3"
                  >
                    <FilterOptionLabel option={option} />
                    <Check
                      aria-hidden="true"
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        checked ? "text-fg-primary" : "invisible",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          ) : (
            <div role="status" className="p-2.5">
              <p className="text-[length:var(--fd-text-xs)] font-medium text-warning">
                {definition.extensionName} filter unavailable
              </p>
              <p className="mt-1 text-[length:var(--fd-text-2xs)] text-fg-muted">
                {definition.unsupportedReason}
              </p>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

export function ExtensionSidebarFilters({
  definitions,
  selections,
  onChange,
}: {
  definitions: ExtensionSidebarFilterDefinition[];
  selections: ReadonlyMap<string, ReadonlySet<string>>;
  onChange: (key: string, selected: ReadonlySet<string>) => void;
}) {
  return definitions.map((definition) => (
    <ExtensionSidebarFilterMenu
      key={definition.key}
      definition={definition}
      selected={selections.get(definition.key) ?? EMPTY_SELECTION}
      onChange={onChange}
    />
  ));
}
