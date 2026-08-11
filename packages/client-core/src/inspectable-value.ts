export type InspectableValueOptions = {
  maxDepth?: number;
  maxEntries?: number;
  maxNodes?: number;
  maxStringLength?: number;
  maxOutputLength?: number;
};

export type InspectableValue = {
  text: string;
  truncated: boolean;
};

const SUMMARY_ENTRY_LIMIT = 1_000;

/**
 * Describes provider-owned structured data without reading property values.
 * This keeps technical disclosures useful before their potentially expensive
 * formatted body is opened.
 */
export function inspectableValueSummary(value: unknown): string {
  if (value === null) return "No value";
  if (Array.isArray(value)) {
    return `${value.length.toLocaleString("en-US")} ${value.length === 1 ? "item" : "items"}`;
  }
  if (typeof value === "string") {
    return `${value.length.toLocaleString("en-US")} ${value.length === 1 ? "character" : "characters"}`;
  }
  if (typeof value !== "object") {
    const kind = typeof value;
    return kind === "undefined"
      ? "No value"
      : kind.replace(/^./, (character) => character.toUpperCase());
  }

  let fields = 0;
  try {
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      fields += 1;
      if (fields >= SUMMARY_ENTRY_LIMIT) return "1,000+ fields";
    }
  } catch {
    return "Structured value";
  }
  return `${fields.toLocaleString("en-US")} ${fields === 1 ? "field" : "fields"}`;
}

const DEFAULT_OPTIONS: Required<InspectableValueOptions> = {
  maxDepth: 8,
  maxEntries: 100,
  maxNodes: 500,
  maxStringLength: 20_000,
  maxOutputLength: 64_000,
};

function safePrefix(value: string, length: number) {
  let prefix = value.slice(0, Math.max(0, length));
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * Formats provider-owned structured data without allowing an unbounded object,
 * string, getter, circular reference, or unsupported primitive to break or
 * monopolize a conversation render.
 */
export function formatInspectableValue(
  value: unknown,
  options: InspectableValueOptions = {},
): InspectableValue {
  const boundedInteger = (value: number | undefined, fallback: number) =>
    Number.isFinite(value)
      ? Math.max(0, Math.floor(value as number))
      : fallback;
  const limits: Required<InspectableValueOptions> = {
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_OPTIONS.maxDepth),
    maxEntries: boundedInteger(options.maxEntries, DEFAULT_OPTIONS.maxEntries),
    maxNodes: boundedInteger(options.maxNodes, DEFAULT_OPTIONS.maxNodes),
    maxStringLength: boundedInteger(
      options.maxStringLength,
      DEFAULT_OPTIONS.maxStringLength,
    ),
    maxOutputLength: boundedInteger(
      options.maxOutputLength,
      DEFAULT_OPTIONS.maxOutputLength,
    ),
  };
  const seen = new WeakSet<object>();
  let nodes = 0;
  let truncated = false;

  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") {
      if (current.length <= limits.maxStringLength) return current;
      truncated = true;
      const omitted = current.length - limits.maxStringLength;
      return `${safePrefix(current, limits.maxStringLength)}… [${omitted} characters omitted]`;
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number")
      return Number.isFinite(current) ? current : String(current);
    if (typeof current === "bigint") return `${current.toString()}n`;
    if (typeof current === "undefined") return "[undefined]";
    if (typeof current === "symbol" || typeof current === "function")
      return String(current);

    if (depth >= limits.maxDepth) {
      truncated = true;
      return "[Maximum depth reached]";
    }
    if (nodes >= limits.maxNodes) {
      truncated = true;
      return "[Node limit reached]";
    }
    nodes += 1;

    const object = current as object;
    if (seen.has(object)) {
      truncated = true;
      return "[Circular reference]";
    }
    seen.add(object);

    if (Array.isArray(current)) {
      const count = Math.min(current.length, limits.maxEntries);
      const result = new Array<unknown>(count);
      for (let index = 0; index < count; index += 1) {
        try {
          result[index] = visit(current[index], depth + 1);
        } catch {
          result[index] = "[Unreadable value]";
        }
      }
      if (current.length > count) {
        truncated = true;
        result.push(`[${current.length - count} entries omitted]`);
      }
      return result;
    }

    const result: Record<string, unknown> = {};
    let count = 0;
    try {
      // Do not call Object.keys here: it allocates an array for every property
      // before the display limit can help, which defeats the bound for a very
      // wide provider object.
      for (const key in current as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        if (count >= limits.maxEntries) {
          truncated = true;
          result["[truncated]"] = "Additional properties omitted";
          break;
        }
        count += 1;
        try {
          result[key] = visit(
            (current as Record<string, unknown>)[key],
            depth + 1,
          );
        } catch {
          result[key] = "[Unreadable value]";
        }
      }
    } catch {
      truncated = true;
      result["[unreadable]"] = "Property enumeration failed";
    }
    return result;
  };

  let text: string;
  try {
    const normalized = visit(value, 0);
    text = JSON.stringify(normalized, null, 2) ?? String(normalized);
  } catch {
    truncated = true;
    try {
      text = String(value);
    } catch {
      text = "[Uninspectable value]";
    }
  }

  if (text.length > limits.maxOutputLength) {
    truncated = true;
    const omitted = text.length - limits.maxOutputLength;
    text = `${safePrefix(text, limits.maxOutputLength)}\n… [display truncated; ${omitted} characters omitted]`;
  }

  return { text, truncated };
}
