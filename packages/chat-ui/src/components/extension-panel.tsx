import {
  Activity,
  Blocks,
  Clock3,
  FileText,
  Kanban,
  Notebook,
  NotebookPen,
  PanelsTopLeft,
  StickyNote,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type {
  ExtensionPanelDefinition,
  ExtensionUiActionBinding,
} from "@falcondeck/client-core";
import { MainView, MainViewBody, cn } from "@falcondeck/ui";

const PANEL_ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  blocks: Blocks,
  clock: Clock3,
  "file-text": FileText,
  kanban: Kanban,
  notebook: Notebook,
  "notebook-pen": NotebookPen,
  "sticky-note": StickyNote,
};

function PanelIcon({
  name,
  className,
}: {
  name?: string | null;
  className?: string;
}) {
  const Icon = (name && PANEL_ICONS[name]) || PanelsTopLeft;
  return <Icon aria-hidden="true" className={className} />;
}

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
  children?: ReactNode;
};

export function ExtensionPanel({
  panel,
  onAction,
  onClose,
  className,
  children,
}: ExtensionPanelProps) {
  const showExtensionName =
    panel.extensionName.trim().toLocaleLowerCase() !==
    panel.title.trim().toLocaleLowerCase();

  return (
    <MainView
      className={className}
      icon={<PanelIcon name={panel.icon} className="h-4 w-4" />}
      title={panel.title}
      meta={showExtensionName ? panel.extensionName : undefined}
      onClose={onClose}
      closeLabel={`Close ${panel.title}`}
    >
      {children ? (
        <MainViewBody layout="workspace">{children}</MainViewBody>
      ) : (
        <MainViewBody>
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
              reason={
                panel.unsupportedReason ?? "Panel content is unavailable"
              }
            />
          )}
        </MainViewBody>
      )}
    </MainView>
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
            <PanelIcon name={panel.icon} className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{panel.title}</span>
          </button>
        );
      })}
    </nav>
  );
}
