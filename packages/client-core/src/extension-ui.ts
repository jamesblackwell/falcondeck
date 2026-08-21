import type {
  ExtensionSnapshot,
  ExtensionUiActionBinding,
  ExtensionUiButtonVariant,
  ExtensionUiDocument,
  ExtensionUiFilterBinding,
  ExtensionUiGap,
  ExtensionUiNode,
  ExtensionUiSelectOption,
  ExtensionUiStateKind,
  ExtensionUiTextStyle,
  ExtensionUiTone,
  ExtensionViewContribution,
} from "./types";
import type { ProjectGroup } from "./grouping";

export const EXTENSION_UI_VERSION = 1 as const;
export const MAX_EXTENSION_UI_DEPTH = 32;
export const MAX_EXTENSION_UI_NODES = 256;
export const MAX_EXTENSION_UI_OPTIONS = 256;
export const MAX_EXTENSION_UI_TEXT_CHARS = 4_096;
export const MAX_EXTENSION_UI_ACTION_INPUT_BYTES = 64 * 1024;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const GAPS = new Set<ExtensionUiGap>(["none", "small", "medium", "large"]);
const TEXT_STYLES = new Set<ExtensionUiTextStyle>([
  "body",
  "heading",
  "caption",
  "mono",
]);
const TONES = new Set<ExtensionUiTone>([
  "default",
  "muted",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
]);
const BUTTON_VARIANTS = new Set<ExtensionUiButtonVariant>([
  "secondary",
  "primary",
  "ghost",
  "danger",
]);
const STATE_KINDS = new Set<ExtensionUiStateKind>([
  "loading",
  "empty",
  "error",
]);
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

type RecordValue = Record<string, unknown>;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function validActionInput(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return (
      encoded !== undefined &&
      new TextEncoder().encode(encoded).byteLength <=
        MAX_EXTENSION_UI_ACTION_INPUT_BYTES
    );
  } catch {
    return false;
  }
}

export type ExtensionUiNormalization =
  { ok: true; document: ExtensionUiDocument } | { ok: false; reason: string };

export type ExtensionSidebarFilterDefinition = {
  key: string;
  extensionId: string;
  extensionName: string;
  contributionId: string;
  title: string;
  document: ExtensionUiDocument | null;
  unsupportedReason: string | null;
};

export type ExtensionPanelDefinition = {
  key: string;
  extensionId: string;
  extensionName: string;
  contributionId: string;
  title: string;
  icon?: string | null;
  document: ExtensionUiDocument | null;
  unsupportedReason: string | null;
};

export type ActiveExtensionThreadFilter = {
  key: string;
  extensionId: string;
  binding: ExtensionUiFilterBinding;
  selectedValues: ReadonlySet<string>;
};

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function hasOnlyKeys(value: RecordValue, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function validText(value: unknown, allowEmpty = true): value is string {
  return (
    typeof value === "string" &&
    characterCount(value) <= MAX_EXTENSION_UI_TEXT_CHARS &&
    (allowEmpty || value.trim().length > 0)
  );
}

function optionalEnum<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
): value is T | undefined {
  return (
    value === undefined || (typeof value === "string" && values.has(value as T))
  );
}

function normalizeScope(value: unknown): { kind: string; id: string } | null {
  const scope = asRecord(value);
  if (!scope || !hasOnlyKeys(scope, ["kind", "id"])) return null;
  return typeof scope.kind === "string" &&
    characterCount(scope.kind) > 0 &&
    characterCount(scope.kind) <= 64 &&
    typeof scope.id === "string" &&
    characterCount(scope.id) > 0 &&
    characterCount(scope.id) <= 512
    ? { kind: scope.kind, id: scope.id }
    : null;
}

function normalizeActionBinding(
  value: unknown,
): ExtensionUiActionBinding | null {
  const action = asRecord(value);
  if (!action || !hasOnlyKeys(action, ["actionId", "input", "target"]))
    return null;
  if (
    typeof action.actionId !== "string" ||
    !IDENTIFIER_PATTERN.test(action.actionId) ||
    (Object.hasOwn(action, "input") && !validActionInput(action.input))
  )
    return null;
  const target =
    action.target === undefined ? undefined : normalizeScope(action.target);
  if (action.target !== undefined && !target) return null;
  return {
    actionId: action.actionId,
    ...(Object.hasOwn(action, "input") ? { input: action.input } : {}),
    ...(target ? { target } : {}),
  };
}

function normalizeFilterBinding(
  value: unknown,
): ExtensionUiFilterBinding | null {
  const binding = asRecord(value);
  if (!binding || !hasOnlyKeys(binding, ["view", "path", "operator"]))
    return null;
  if (
    typeof binding.view !== "string" ||
    !IDENTIFIER_PATTERN.test(binding.view) ||
    binding.operator !== "includes_any" ||
    !Array.isArray(binding.path) ||
    binding.path.length === 0 ||
    binding.path.length > 16 ||
    !binding.path.every(
      (segment) =>
        typeof segment === "string" &&
        characterCount(segment) > 0 &&
        characterCount(segment) <= 128 &&
        !UNSAFE_PATH_SEGMENTS.has(segment),
    )
  )
    return null;
  return { view: binding.view, path: binding.path, operator: "includes_any" };
}

function normalizeOptions(value: unknown): ExtensionUiSelectOption[] | null {
  if (!Array.isArray(value) || value.length > MAX_EXTENSION_UI_OPTIONS)
    return null;
  const options: ExtensionUiSelectOption[] = [];
  const values = new Set<string>();
  for (const candidate of value) {
    const option = asRecord(candidate);
    if (!option || !hasOnlyKeys(option, ["value", "label", "tone"]))
      return null;
    if (
      typeof option.value !== "string" ||
      characterCount(option.value) === 0 ||
      characterCount(option.value) > 256 ||
      values.has(option.value) ||
      !validText(option.label, false) ||
      !optionalEnum(option.tone, TONES)
    )
      return null;
    values.add(option.value);
    options.push({
      value: option.value,
      label: option.label,
      ...(option.tone ? { tone: option.tone } : {}),
    });
  }
  return options;
}

function normalizeNode(
  value: unknown,
  depth: number,
  counter: { value: number },
): ExtensionUiNode | null {
  if (depth > MAX_EXTENSION_UI_DEPTH || counter.value >= MAX_EXTENSION_UI_NODES)
    return null;
  const node = asRecord(value);
  if (!node || typeof node.type !== "string") return null;
  counter.value += 1;

  if (node.type === "stack" || node.type === "row") {
    const allowed =
      node.type === "row"
        ? ["type", "gap", "wrap", "children"]
        : ["type", "gap", "children"];
    if (
      !hasOnlyKeys(node, allowed) ||
      !optionalEnum(node.gap, GAPS) ||
      (node.type === "row" &&
        node.wrap !== undefined &&
        typeof node.wrap !== "boolean") ||
      !Array.isArray(node.children) ||
      node.children.length > MAX_EXTENSION_UI_NODES
    )
      return null;
    const children = node.children.map((child) =>
      normalizeNode(child, depth + 1, counter),
    );
    if (children.some((child) => child === null)) return null;
    return node.type === "stack"
      ? {
          type: "stack",
          ...(node.gap ? { gap: node.gap } : {}),
          children: children as ExtensionUiNode[],
        }
      : {
          type: "row",
          ...(node.gap ? { gap: node.gap } : {}),
          ...(node.wrap === true ? { wrap: true } : {}),
          children: children as ExtensionUiNode[],
        };
  }

  if (node.type === "text") {
    if (
      !hasOnlyKeys(node, ["type", "text", "style", "tone"]) ||
      !validText(node.text) ||
      !optionalEnum(node.style, TEXT_STYLES) ||
      !optionalEnum(node.tone, TONES)
    )
      return null;
    return {
      type: "text",
      text: node.text,
      ...(node.style ? { style: node.style } : {}),
      ...(node.tone ? { tone: node.tone } : {}),
    };
  }

  if (node.type === "badge") {
    if (
      !hasOnlyKeys(node, ["type", "text", "tone"]) ||
      !validText(node.text) ||
      !optionalEnum(node.tone, TONES)
    )
      return null;
    return {
      type: "badge",
      text: node.text,
      ...(node.tone ? { tone: node.tone } : {}),
    };
  }

  if (node.type === "divider") {
    return hasOnlyKeys(node, ["type"]) ? { type: "divider" } : null;
  }

  if (node.type === "button") {
    const action = normalizeActionBinding(node.action);
    if (
      !hasOnlyKeys(node, ["type", "label", "action", "variant", "disabled"]) ||
      !validText(node.label, false) ||
      !action ||
      !optionalEnum(node.variant, BUTTON_VARIANTS) ||
      (node.disabled !== undefined && typeof node.disabled !== "boolean")
    )
      return null;
    return {
      type: "button",
      label: node.label,
      action,
      ...(node.variant ? { variant: node.variant } : {}),
      ...(node.disabled === true ? { disabled: true } : {}),
    };
  }

  if (node.type === "list") {
    if (
      !hasOnlyKeys(node, ["type", "items"]) ||
      !Array.isArray(node.items) ||
      node.items.length > MAX_EXTENSION_UI_NODES
    )
      return null;
    const items = node.items.map((item) =>
      normalizeNode(item, depth + 1, counter),
    );
    return items.some((item) => item === null)
      ? null
      : { type: "list", items: items as ExtensionUiNode[] };
  }

  if (node.type === "select") {
    const options = normalizeOptions(node.options);
    const binding = normalizeFilterBinding(node.binding);
    if (
      !hasOnlyKeys(node, [
        "type",
        "id",
        "label",
        "multiple",
        "options",
        "binding",
      ]) ||
      typeof node.id !== "string" ||
      !IDENTIFIER_PATTERN.test(node.id) ||
      !validText(node.label, false) ||
      (node.multiple !== undefined && typeof node.multiple !== "boolean") ||
      !options ||
      !binding
    )
      return null;
    return {
      type: "select",
      id: node.id,
      label: node.label,
      ...(node.multiple === true ? { multiple: true } : {}),
      options,
      binding,
    };
  }

  if (node.type === "state") {
    if (
      !hasOnlyKeys(node, ["type", "state", "title", "description"]) ||
      typeof node.state !== "string" ||
      !STATE_KINDS.has(node.state as ExtensionUiStateKind) ||
      !validText(node.title, false) ||
      (node.description !== undefined && !validText(node.description))
    )
      return null;
    return {
      type: "state",
      state: node.state as ExtensionUiStateKind,
      title: node.title,
      ...(typeof node.description === "string"
        ? { description: node.description }
        : {}),
    };
  }

  return null;
}

export function normalizeExtensionUiDocument(
  value: unknown,
): ExtensionUiNormalization {
  const document = asRecord(value);
  if (!document || !hasOnlyKeys(document, ["version", "root"])) {
    return { ok: false, reason: "Malformed declarative UI document" };
  }
  if (document.version !== EXTENSION_UI_VERSION) {
    return {
      ok: false,
      reason:
        typeof document.version === "number"
          ? `Declarative UI v${document.version} is not supported by this client`
          : "Declarative UI version is missing",
    };
  }
  const root = normalizeNode(document.root, 1, { value: 0 });
  return root
    ? { ok: true, document: { version: EXTENSION_UI_VERSION, root } }
    : {
        ok: false,
        reason: "Declarative UI is malformed or exceeds client limits",
      };
}

function documentForContribution(
  snapshot: ExtensionSnapshot,
  extensionId: string,
  contribution: ExtensionViewContribution,
): ExtensionUiNormalization {
  const published = snapshot.views.find(
    (view) =>
      view.extension_id === extensionId &&
      view.view_id === contribution.view &&
      view.scope == null,
  );
  const publishedRecord = asRecord(published?.value);
  if (
    publishedRecord &&
    "version" in publishedRecord &&
    "root" in publishedRecord
  ) {
    return normalizeExtensionUiDocument(published?.value);
  }
  if (contribution.uiUnsupportedReason) {
    return { ok: false, reason: contribution.uiUnsupportedReason };
  }
  return normalizeExtensionUiDocument(contribution.ui);
}

export function deriveExtensionSidebarFilters(
  snapshot: ExtensionSnapshot | null | undefined,
): ExtensionSidebarFilterDefinition[] {
  if (!snapshot) return [];
  return snapshot.catalog.flatMap((extension) => {
    if (!extension.enabled) return [];
    return extension.contributes.sidebarFilters.flatMap((contribution) => {
      const published = snapshot.views.find(
        (view) =>
          view.extension_id === extension.id &&
          view.view_id === contribution.view &&
          view.scope == null,
      );
      const publishedRecord = asRecord(published?.value);
      const hasPublishedUi =
        publishedRecord !== null &&
        "version" in publishedRecord &&
        "root" in publishedRecord;
      if (
        contribution.ui == null &&
        !contribution.uiUnsupportedReason &&
        !hasPublishedUi
      ) {
        return [];
      }
      const normalized = documentForContribution(
        snapshot,
        extension.id,
        contribution,
      );
      return [
        {
          key: `${extension.id}:${contribution.id}`,
          extensionId: extension.id,
          extensionName: extension.name,
          contributionId: contribution.id,
          title: contribution.title ?? extension.name,
          document: normalized.ok ? normalized.document : null,
          unsupportedReason: normalized.ok ? null : normalized.reason,
        },
      ];
    });
  });
}

/** Resolves enabled panel declarations against synchronized global UI state. */
export function deriveExtensionPanels(
  snapshot: ExtensionSnapshot | null | undefined,
): ExtensionPanelDefinition[] {
  if (!snapshot) return [];
  return snapshot.catalog.flatMap((extension) => {
    if (!extension.enabled) return [];
    return (extension.contributes.panels ?? []).map((contribution) => {
      const published = snapshot.views.find(
        (view) =>
          view.extension_id === extension.id &&
          view.view_id === contribution.view &&
          view.scope == null,
      );
      const publishedRecord = asRecord(published?.value);
      const hasPublishedUi =
        publishedRecord !== null &&
        "version" in publishedRecord &&
        "root" in publishedRecord;
      const hasDeclarativeUi =
        contribution.ui != null ||
        contribution.uiUnsupportedReason != null ||
        hasPublishedUi;
      const normalized = hasDeclarativeUi
        ? documentForContribution(snapshot, extension.id, contribution)
        : null;

      return {
        key: `${extension.id}:${contribution.id}`,
        extensionId: extension.id,
        extensionName: extension.name,
        contributionId: contribution.id,
        title: contribution.title ?? extension.name,
        icon: contribution.icon ?? null,
        document: normalized?.ok ? normalized.document : null,
        unsupportedReason:
          normalized == null
            ? "Panel content has not been published"
            : normalized.ok
              ? null
              : normalized.reason,
      };
    });
  });
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record || UNSAFE_PATH_SEGMENTS.has(segment)) return undefined;
    current = record[segment];
  }
  return current;
}

function threadMatchesFilter(
  snapshot: ExtensionSnapshot,
  threadId: string,
  filter: ActiveExtensionThreadFilter,
): boolean {
  const view = snapshot.views.find(
    (candidate) =>
      candidate.extension_id === filter.extensionId &&
      candidate.view_id === filter.binding.view &&
      candidate.scope?.kind === "thread" &&
      candidate.scope.id === threadId,
  );
  const values = valueAtPath(view?.value, filter.binding.path);
  return (
    Array.isArray(values) &&
    values.some(
      (value) => typeof value === "string" && filter.selectedValues.has(value),
    )
  );
}

export function filterProjectGroupsByExtensions(
  groups: ProjectGroup[],
  snapshot: ExtensionSnapshot | null | undefined,
  filters: readonly ActiveExtensionThreadFilter[],
): ProjectGroup[] {
  const active = filters.filter((filter) => filter.selectedValues.size > 0);
  if (!snapshot || active.length === 0) return groups;
  return groups.flatMap((group) => {
    const threads = group.threads.filter((thread) =>
      active.every((filter) =>
        threadMatchesFilter(snapshot, thread.id, filter),
      ),
    );
    return threads.length > 0 ? [{ ...group, threads }] : [];
  });
}
