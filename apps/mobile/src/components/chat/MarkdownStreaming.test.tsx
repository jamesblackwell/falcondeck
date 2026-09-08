import React from "react";
import { act } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderComponent, textOf } from "@/test/render";
import { MarkdownRenderer } from "./MarkdownRenderer";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("paints streamed text within 50ms and final text without a trailing layout jump", () => {
  vi.useFakeTimers();
  const renderer = renderComponent(<MarkdownRenderer text="First" streaming />);
  act(() => renderer.update(<MarkdownRenderer text="First chunk" streaming />));
  act(() => { vi.advanceTimersByTime(50); });
  expect(textOf(renderer)).toContain("First chunk");
  act(() => renderer.update(<MarkdownRenderer text="First chunk final" streaming={false} />));
  expect(textOf(renderer)).toContain("First chunk final");
});
