// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";

import { useExtensionApps } from "./app-host";

it("does not schedule a redundant render when there are no extension frontends", async () => {
  let renderCount = 0;
  const { result } = renderHook(() => {
    renderCount += 1;
    return useExtensionApps([], {});
  });

  await act(async () => {
    await Promise.resolve();
  });

  expect(result.current.size).toBe(0);
  expect(renderCount).toBe(1);
});
