import React from "react";
import { Linking } from "react-native";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, renderComponent } from "@/test/render";

import { useExternalUrl } from "./useExternalUrl";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("useExternalUrl", () => {
  it("coalesces repeated taps and exposes the authoritative busy state", async () => {
    const handoff = deferred();
    const openUrl = vi
      .spyOn(Linking, "openURL")
      .mockReturnValue(handoff.promise);
    let value: ReturnType<typeof useExternalUrl> | null = null;

    function Harness() {
      value = useExternalUrl("https://example.com/source");
      return null;
    }

    renderComponent(<Harness />);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = value!.open();
      second = value!.open();
    });

    expect(first).toBe(second);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(value!.opening).toBe(true);
    expect(value!.failed).toBe(false);

    await act(async () => {
      handoff.resolve();
      await first;
    });
    expect(value!.opening).toBe(false);
    expect(value!.failed).toBe(false);
  });

  it("retains a retryable failure and clears it after a successful retry", async () => {
    const failure = deferred();
    const retry = deferred();
    vi.spyOn(Linking, "openURL")
      .mockReturnValueOnce(failure.promise)
      .mockReturnValueOnce(retry.promise);
    let value: ReturnType<typeof useExternalUrl> | null = null;

    function Harness() {
      value = useExternalUrl("https://example.com/source");
      return null;
    }

    renderComponent(<Harness />);
    await act(async () => {
      const operation = value!.open();
      failure.reject(new Error("No browser"));
      await operation;
    });
    expect(value!.failed).toBe(true);

    let retryOperation!: Promise<void>;
    act(() => {
      retryOperation = value!.open();
    });
    expect(value!.opening).toBe(true);
    expect(value!.failed).toBe(false);

    await act(async () => {
      retry.resolve();
      await retryOperation;
    });
    expect(value!.opening).toBe(false);
    expect(value!.failed).toBe(false);
  });

  it("ignores an old target failure after a newer target succeeds", async () => {
    const oldHandoff = deferred();
    const newHandoff = deferred();
    vi.spyOn(Linking, "openURL")
      .mockReturnValueOnce(oldHandoff.promise)
      .mockReturnValueOnce(newHandoff.promise);
    let value: ReturnType<typeof useExternalUrl> | null = null;

    function Harness({ url }: { url: string }) {
      value = useExternalUrl(url);
      return null;
    }

    const renderer = renderComponent(<Harness url="https://example.com/old" />);
    let oldOperation!: Promise<void>;
    act(() => {
      oldOperation = value!.open();
      renderer.update(<Harness url="https://example.com/new" />);
    });

    let newOperation!: Promise<void>;
    act(() => {
      newOperation = value!.open();
    });
    await act(async () => {
      newHandoff.resolve();
      await newOperation;
    });
    expect(value!.failed).toBe(false);

    await act(async () => {
      oldHandoff.reject(new Error("Old browser failure"));
      await oldOperation;
    });
    expect(value!.opening).toBe(false);
    expect(value!.failed).toBe(false);
  });
});
