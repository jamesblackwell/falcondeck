import { describe, expect, it } from "vitest";

import {
  formatInspectableValue,
  inspectableValueSummary,
} from "./inspectable-value";

describe("inspectableValueSummary", () => {
  it("summarizes common provider argument shapes without reading values", () => {
    let getterReads = 0;
    const value = {
      query: "streaming",
      get expensive() {
        getterReads += 1;
        return { deeply: "nested" };
      },
    };

    expect(inspectableValueSummary(value)).toBe("2 fields");
    expect(inspectableValueSummary([1, 2, 3])).toBe("3 items");
    expect(inspectableValueSummary("hello")).toBe("5 characters");
    expect(inspectableValueSummary(null)).toBe("No value");
    expect(getterReads).toBe(0);
  });

  it("bounds adversarially wide objects and survives failed enumeration", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 1_100 }, (_, index) => [`field_${index}`, index]),
    );
    const broken = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("provider enumeration failed");
        },
      },
    );

    expect(inspectableValueSummary(wide)).toBe("1,000+ fields");
    expect(inspectableValueSummary(broken)).toBe("Structured value");
  });
});

describe("formatInspectableValue", () => {
  it("preserves ordinary structured provider output", () => {
    expect(formatInspectableValue({ ok: true, count: 2 }).text).toBe(
      '{\n  "ok": true,\n  "count": 2\n}',
    );
  });

  it("bounds strings, collections, depth, and final output", () => {
    const value = {
      long: "abcdef",
      entries: [1, 2, 3],
      nested: { deeper: { value: true } },
    };
    const result = formatInspectableValue(value, {
      maxDepth: 2,
      maxEntries: 2,
      maxStringLength: 3,
      maxOutputLength: 80,
    });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(140);
    expect(result.text).toContain("characters omitted");
    expect(result.text).toContain("display truncated");
  });

  it("survives circular values, bigint, and throwing getters", () => {
    const value: Record<string, unknown> = { count: 7n };
    value.self = value;
    Object.defineProperty(value, "broken", {
      enumerable: true,
      get() {
        throw new Error("provider getter failed");
      },
    });

    const result = formatInspectableValue(value);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("7n");
    expect(result.text).toContain("Circular reference");
    expect(result.text).toContain("Unreadable value");
  });

  it("does not read properties beyond the collection limit", () => {
    let getterReads = 0;
    const value: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) {
      Object.defineProperty(value, `field_${index}`, {
        enumerable: true,
        get() {
          getterReads += 1;
          return index;
        },
      });
    }

    const result = formatInspectableValue(value, { maxEntries: 3 });
    expect(result.truncated).toBe(true);
    expect(getterReads).toBe(3);
    expect(result.text).toContain("Additional properties omitted");
  });

  it("sanitizes invalid caller limits instead of throwing", () => {
    expect(() =>
      formatInspectableValue([1, 2], {
        maxEntries: -10,
        maxDepth: Number.NaN,
        maxOutputLength: Number.POSITIVE_INFINITY,
      }),
    ).not.toThrow();
  });
});
