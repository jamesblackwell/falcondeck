import { memo, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import type {
  ExtensionUiActionBinding,
  ExtensionUiDocument,
  ExtensionUiGap,
  ExtensionUiNode,
  ExtensionUiSelectOption,
  ExtensionUiTone,
} from "@falcondeck/client-core";
import { Badge, Button, EmptyState, cn } from "@falcondeck/ui";

const GAP_CLASSES: Record<ExtensionUiGap, string> = {
  none: "gap-0",
  small: "gap-1.5",
  medium: "gap-3",
  large: "gap-5",
};

const TEXT_TONE_CLASSES: Record<ExtensionUiTone, string> = {
  default: "text-fg-primary",
  muted: "text-fg-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  gray: "text-fg-muted",
  red: "text-danger",
  orange: "text-warning",
  yellow: "text-warning",
  green: "text-success",
  blue: "text-info",
  purple: "text-accent",
  pink: "text-accent",
};

export const EXTENSION_SWATCH_CLASSES: Record<ExtensionUiTone, string> = {
  default: "bg-fg-tertiary",
  muted: "bg-fg-muted",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  gray: "bg-fg-muted",
  red: "bg-danger",
  orange: "bg-warning",
  yellow: "bg-warning",
  green: "bg-success",
  blue: "bg-info",
  purple: "bg-accent",
  pink: "bg-accent",
};

const TEXT_STYLE_CLASSES = {
  body: "text-[length:var(--fd-text-sm)]",
  heading: "text-[length:var(--fd-text-lg)] font-semibold text-fg-primary",
  caption: "text-[length:var(--fd-text-xs)] text-fg-muted",
  mono: "font-mono text-[length:var(--fd-text-xs)]",
} as const;

const EMPTY_SELECTION = new Set<string>();

type SelectionHandler = (
  node: Extract<ExtensionUiNode, { type: "select" }>,
  selected: ReadonlySet<string>,
) => void;

export type ExtensionUiRendererProps = {
  extensionId: string;
  document: ExtensionUiDocument;
  onAction?: (
    extensionId: string,
    action: ExtensionUiActionBinding,
  ) => Promise<unknown> | unknown;
  selections?: ReadonlyMap<string, ReadonlySet<string>>;
  onSelectionChange?: SelectionHandler;
  className?: string;
};

type ExtensionUiNodeRendererProps = Omit<
  ExtensionUiRendererProps,
  "document" | "className"
> & {
  node: ExtensionUiNode;
  nodeKey: string;
};

function optionLabel(option: ExtensionUiSelectOption) {
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
      <span>{option.label}</span>
    </>
  );
}

function ExtensionActionButton({
  extensionId,
  node,
  onAction,
}: {
  extensionId: string;
  node: Extract<ExtensionUiNode, { type: "button" }>;
  onAction?: ExtensionUiRendererProps["onAction"];
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const variant =
    node.variant === "primary" ? "default" : (node.variant ?? "secondary");

  const handleClick = async () => {
    if (!onAction || pending) return;
    setPending(true);
    setError(null);
    try {
      await onAction(extensionId, node.action);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Extension action failed",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant={variant}
        disabled={node.disabled || !onAction || pending}
        aria-busy={pending}
        onClick={handleClick}
      >
        {pending ? (
          <LoaderCircle
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin"
          />
        ) : null}
        {node.label}
      </Button>
      {error ? (
        <p role="alert" className="text-[length:var(--fd-text-xs)] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ExtensionSelectControl({
  node,
  selected,
  onSelectionChange,
}: {
  node: Extract<ExtensionUiNode, { type: "select" }>;
  selected: ReadonlySet<string>;
  onSelectionChange?: SelectionHandler;
}) {
  const toggle = (value: string) => {
    if (!onSelectionChange) return;
    const next = new Set(node.multiple ? selected : []);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onSelectionChange(node, next);
  };

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
        {node.label}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {node.options.map((option) => {
          const checked = selected.has(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role={node.multiple ? "checkbox" : "radio"}
              aria-checked={checked}
              disabled={!onSelectionChange}
              onClick={() => toggle(option.value)}
              className={cn(
                "fd-focus inline-flex min-h-8 items-center gap-2 rounded-[var(--fd-radius-md)] border px-2.5 text-[length:var(--fd-text-xs)] transition-colors",
                checked
                  ? "border-border-emphasis bg-surface-3 text-fg-primary"
                  : "border-border-subtle bg-surface-2 text-fg-secondary hover:bg-surface-3",
              )}
            >
              {optionLabel(option)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

const ExtensionUiNodeRenderer = memo(function ExtensionUiNodeRenderer({
  node,
  nodeKey,
  extensionId,
  onAction,
  selections,
  onSelectionChange,
}: ExtensionUiNodeRendererProps) {
  if (node.type === "stack" || node.type === "row") {
    return (
      <div
        className={cn(
          "flex min-w-0",
          node.type === "stack" ? "flex-col" : "items-center",
          node.type === "row" && node.wrap ? "flex-wrap" : null,
          GAP_CLASSES[node.gap ?? "medium"],
        )}
      >
        {node.children.map((child, index) => (
          <ExtensionUiNodeRenderer
            key={`${nodeKey}:${index}`}
            node={child}
            nodeKey={`${nodeKey}:${index}`}
            extensionId={extensionId}
            onAction={onAction}
            selections={selections}
            onSelectionChange={onSelectionChange}
          />
        ))}
      </div>
    );
  }

  if (node.type === "text") {
    const className = cn(
      TEXT_STYLE_CLASSES[node.style ?? "body"],
      TEXT_TONE_CLASSES[node.tone ?? "default"],
    );
    return node.style === "heading" ? (
      <h3 className={className}>{node.text}</h3>
    ) : (
      <p className={className}>{node.text}</p>
    );
  }

  if (node.type === "badge") {
    const variant =
      node.tone === "success" ||
      node.tone === "warning" ||
      node.tone === "danger" ||
      node.tone === "info"
        ? node.tone
        : "default";
    return <Badge variant={variant}>{node.text}</Badge>;
  }

  if (node.type === "divider") {
    return <hr className="w-full border-0 border-t border-border-subtle" />;
  }

  if (node.type === "button") {
    return (
      <ExtensionActionButton
        extensionId={extensionId}
        node={node}
        onAction={onAction}
      />
    );
  }

  if (node.type === "list") {
    return (
      <ul className="min-w-0 space-y-2">
        {node.items.map((item, index) => (
          <li key={`${nodeKey}:${index}`} className="min-w-0">
            <ExtensionUiNodeRenderer
              node={item}
              nodeKey={`${nodeKey}:${index}`}
              extensionId={extensionId}
              onAction={onAction}
              selections={selections}
              onSelectionChange={onSelectionChange}
            />
          </li>
        ))}
      </ul>
    );
  }

  if (node.type === "select") {
    return (
      <ExtensionSelectControl
        node={node}
        selected={selections?.get(node.id) ?? EMPTY_SELECTION}
        onSelectionChange={onSelectionChange}
      />
    );
  }

  return (
    <EmptyState
      icon={
        node.state === "loading" ? (
          <LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin" />
        ) : node.state === "error" ? (
          <AlertTriangle aria-hidden="true" className="h-5 w-5" />
        ) : undefined
      }
      title={node.title}
      description={node.description ?? undefined}
      className="py-6"
    />
  );
});

export function ExtensionUiRenderer({
  extensionId,
  document,
  onAction,
  selections,
  onSelectionChange,
  className,
}: ExtensionUiRendererProps) {
  return (
    <div
      className={cn("min-w-0", className)}
      data-extension-ui-version={document.version}
    >
      <ExtensionUiNodeRenderer
        node={document.root}
        nodeKey="root"
        extensionId={extensionId}
        onAction={onAction}
        selections={selections}
        onSelectionChange={onSelectionChange}
      />
    </div>
  );
}

export function ExtensionUiFallback({
  extensionName,
  contributionKind,
  reason,
  className,
}: {
  extensionName: string;
  contributionKind: string;
  reason: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-3",
        className,
      )}
    >
      <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
        {extensionName} provides an unsupported {contributionKind}
      </p>
      <p className="mt-1 text-[length:var(--fd-text-2xs)] text-fg-muted">
        {reason}
      </p>
    </div>
  );
}
