import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useParakeetStatus } from "./parakeet";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const status = { supported: true, installed: true, loaded: false, busy: false, progress: null, phase: "", error: null };
beforeEach(() => {
  window.__TAURI_INTERNALS__ = {} as never;
  invoke.mockReset().mockResolvedValue(status);
});
afterEach(() => { delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });

it("reads cached status without downloading or loading a model", async () => {
  const { result } = renderHook(useParakeetStatus);
  await waitFor(() => expect(result.current.status).toEqual(status));
  expect(invoke.mock.calls).toEqual([["parakeet_status"]]);
});

it("downloads only when explicitly requested and exposes setup failures", async () => {
  const { result } = renderHook(useParakeetStatus);
  await waitFor(() => expect(result.current.status).toEqual(status));
  invoke.mockRejectedValueOnce("Download interrupted");
  await act(async () => { await result.current.prepare(); });
  expect(invoke).toHaveBeenLastCalledWith("prepare_parakeet");
  expect(result.current.error).toBe("Download interrupted");
  expect(result.current.preparing).toBe(false);
  invoke.mockResolvedValueOnce({ ...status, loaded: true });
  await act(async () => { await result.current.prepare(); });
  expect(result.current.error).toBeNull();
  expect(result.current.status?.loaded).toBe(true);
});
