import { PanelsTopLeft, X } from "lucide-react";

import type {
  ExtensionPanelDefinition,
  ExtensionUiActionBinding,
} from "@falcondeck/client-core";
import { Button, cn } from "@falcondeck/ui";

import {
  ExtensionUiFallback,
  ExtensionUiRenderer,
} from "./extension-ui-renderer";

export type ExtensionPanelProps = {
  panel: ExtensionPanelDefinition;
  onAction?: (
    extensionId: string,
    action: ExtensionUiActionBinding,
  ) => Promise<unknown> | unknown;
  onClose?: () => void;
  className?: string;
};

export function ExtensionPanel({
  panel,
  onAction,
  onClose,
  className,
}: ExtensionPanelProps) {
  return (
    <section
      aria-label={panel.title}
      className={cn("flex h-full min-h-0 flex-col bg-surface-0", className)}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border-subtle px-5 py-3">
        <PanelsTopLeft aria-hidden="true" className="h-4 w-4 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
            {panel.title}
          </h1>
          <p className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
            {panel.extensionName}
          </p>
        </div>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Close ${panel.title}`}
            onClick={onClose}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto w-full max-w-4xl">
          {panel.document ? (
            <ExtensionUiRenderer
              extensionId={panel.extensionId}
              document={panel.document}
              onAction={onAction}
            />
          ) : (
            <ExtensionUiFallback
              extensionName={panel.extensionName}
              contributionKind="panel"
              reason={panel.unsupportedReason ?? "Panel content is unavailable"}
            />
          )}
        </div>
      </div>
    </section>
  );
}

export function ExtensionPanelNavigation({
  panels,
  activePanelKey,
  onSelect,
  className,
}: {
  panels: readonly ExtensionPanelDefinition[];
  activePanelKey?: string | null;
  onSelect: (panelKey: string) => void;
  className?: string;
}) {
  if (panels.length === 0) return null;
  return (
    <nav aria-label="Extension panels" className={cn("space-y-1", className)}>
      {panels.map((panel) => {
        const active = activePanelKey === panel.key;
        return (
          <button
            key={panel.key}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(panel.key)}
            className={cn(
              "fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors",
              active
                ? "bg-surface-3 text-fg-primary"
                : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
            )}
          >
            <PanelsTopLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{panel.title}</span>
          </button>
        );
      })}
    </nav>
  );
}
