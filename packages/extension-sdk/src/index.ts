export type ExtensionViewScope = { kind: string; id: string };

export type ExtensionUiGap = "none" | "small" | "medium" | "large";
export type ExtensionUiTextStyle = "body" | "heading" | "caption" | "mono";
export type ExtensionUiTone =
  | "default"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink";
export type ExtensionUiButtonVariant =
  "secondary" | "primary" | "ghost" | "danger";
export type ExtensionUiStateKind = "loading" | "empty" | "error";

export type ExtensionUiActionBinding<TInput = unknown> = {
  actionId: string;
  input?: TInput;
  target?: ExtensionViewScope;
};

export type ExtensionUiFilterBinding = {
  view: string;
  path: string[];
  operator: "includes_any";
};

export type ExtensionUiSelectOption = {
  value: string;
  label: string;
  tone?: ExtensionUiTone;
};

export type ExtensionUiNode =
  | { type: "stack"; gap?: ExtensionUiGap; children: ExtensionUiNode[] }
  | {
      type: "row";
      gap?: ExtensionUiGap;
      wrap?: boolean;
      children: ExtensionUiNode[];
    }
  | {
      type: "text";
      text: string;
      style?: ExtensionUiTextStyle;
      tone?: ExtensionUiTone;
    }
  | { type: "badge"; text: string; tone?: ExtensionUiTone }
  | { type: "divider" }
  | {
      type: "button";
      label: string;
      action: ExtensionUiActionBinding;
      variant?: ExtensionUiButtonVariant;
      disabled?: boolean;
    }
  | { type: "list"; items: ExtensionUiNode[] }
  | {
      type: "select";
      id: string;
      label: string;
      multiple?: boolean;
      options: ExtensionUiSelectOption[];
      binding: ExtensionUiFilterBinding;
    }
  | {
      type: "state";
      state: ExtensionUiStateKind;
      title: string;
      description?: string;
    };

export type ExtensionUiDocument = {
  version: 1;
  root: ExtensionUiNode;
};

/** Preserves literal component and action identifiers while type-checking a document. */
export function defineExtensionUi<const TDocument extends ExtensionUiDocument>(
  document: TDocument,
): TDocument {
  return document;
}

export type ExtensionActionInvocation<TInput = unknown> = {
  target?: ExtensionViewScope;
  input: TInput;
};

export type PublishedExtensionView<TValue = unknown> = {
  viewId: string;
  scope?: ExtensionViewScope;
  value: TValue;
};

export type ExtensionContext = {
  extension: { id: string };
  actions: {
    register<TInput = unknown, TResult = unknown>(
      id: string,
      handler: (
        invocation: ExtensionActionInvocation<TInput>,
      ) => TResult | Promise<TResult>,
    ): void;
  };
  storage: {
    get<T>(key: string, fallback: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  views: { publish<T>(view: PublishedExtensionView<T>): Promise<void> };
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
};

export type ExtensionDefinition = {
  activate(context: ExtensionContext): void | Promise<void>;
};

export function defineExtension(
  definition: ExtensionDefinition,
): ExtensionDefinition {
  return definition;
}
